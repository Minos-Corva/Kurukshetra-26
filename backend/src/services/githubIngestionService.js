/**
 * githubIngestionService.js
 *
 * Interacts with GitHub via Octokit to:
 * 1. Validate repository existence and resolve default/target branch.
 * 2. Resolve commit SHA for the target branch.
 * 3. Fetch recursive tree of files.
 * 4. Filter for eligible text files (skipping binaries, lockfiles, node_modules, minified files, etc.).
 * 5. Fetch file blob contents decoded to UTF-8.
 */

const MAX_FILE_SIZE_BYTES = 100 * 1024; // 100 KB
const MAX_FILE_COUNT = 300;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024; // 5 MB

const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "vendor",
  "vendors",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "coverage",
  ".idea",
  ".vscode",
  "target",
  "bin",
  "obj",
  "__pycache__",
  ".pytest_cache",
  ".venv",
  "venv",
  "env",
]);

const EXCLUDED_FILENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "composer.lock",
  "gemfile.lock",
  "cargo.lock",
  "poetry.lock",
  ".ds_store",
  "thumbs.db",
]);

const EXCLUDED_EXTENSIONS = new Set([
  // Images
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".webp",
  // Documents / binaries / archives
  ".pdf", ".zip", ".tar", ".gz", ".7z", ".rar",
  // Executables / libraries / bytecode
  ".exe", ".dll", ".so", ".dylib", ".class", ".jar", ".war", ".pyc", ".pyo", ".wasm",
  // Audio / Video
  ".mp3", ".mp4", ".wav", ".mov", ".avi",
  // Fonts
  ".woff", ".woff2", ".ttf", ".eot",
  // Databases / binary data
  ".db", ".sqlite", ".sqlite3", ".bin",
]);

const INCLUDED_NOEXT_NAMES = new Set([
  "dockerfile",
  "makefile",
  ".gitignore",
  ".dockerignore",
  ".editorconfig",
  ".npmrc",
  ".eslintrc",
  ".prettierrc",
]);

export function isEligibleFile(filePath, size = 0) {
  if (!filePath || typeof filePath !== "string") return false;

  // Check file size if provided
  if (size && size > MAX_FILE_SIZE_BYTES) {
    return false;
  }

  // Normalize path with forward slashes
  const normalizedPath = filePath.replace(/\\/g, "/");
  const parts = normalizedPath.split("/");
  const fileName = parts[parts.length - 1];
  const lowerFileName = fileName.toLowerCase();

  // 1. Check directory exclusions
  for (let i = 0; i < parts.length - 1; i++) {
    if (EXCLUDED_DIRS.has(parts[i].toLowerCase())) {
      return false;
    }
  }

  // 2. Check excluded exact filenames
  if (EXCLUDED_FILENAMES.has(lowerFileName)) {
    return false;
  }

  // 3. Skip minified / bundled files
  if (/\.(min|bundle)\.(js|css)$/i.test(fileName)) {
    return false;
  }

  // 4. Check included special filenames (like Dockerfile, .gitignore, etc.)
  if (INCLUDED_NOEXT_NAMES.has(lowerFileName) || lowerFileName === ".env.example") {
    return true;
  }

  // 5. Check extension
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex === -1 || dotIndex === 0) {
    // No extension or dotfile not explicitly included
    return false;
  }

  const ext = fileName.slice(dotIndex).toLowerCase();
  if (EXCLUDED_EXTENSIONS.has(ext)) {
    return false;
  }

  return true;
}

export class GithubIngestionService {
  /**
   * @param {object} options
   * @param {import('octokit').Octokit} options.octokit
   * @param {number} [options.maxFileSize]
   * @param {number} [options.maxFileCount]
   * @param {number} [options.maxTotalBytes]
   */
  constructor({
    octokit,
    maxFileSize = MAX_FILE_SIZE_BYTES,
    maxFileCount = MAX_FILE_COUNT,
    maxTotalBytes = MAX_TOTAL_BYTES,
  } = {}) {
    if (!octokit) {
      throw new Error("octokit client is required");
    }
    this.octokit = octokit;
    this.maxFileSize = maxFileSize;
    this.maxFileCount = maxFileCount;
    this.maxTotalBytes = maxTotalBytes;
  }

  /**
   * Fetch repository metadata, commit SHA, file tree, and contents.
   *
   * @param {object} params
   * @param {string} params.owner
   * @param {string} params.name
   * @param {string} [params.branch]
   * @returns {Promise<{
   *   repository: { owner: string, name: string, fullName: string, htmlUrl: string, defaultBranch: string },
   *   branch: string,
   *   commitSha: string,
   *   files: Array<{ filePath: string, content: string, blobSha: string, commitSha: string, size: number }>
   * }>}
   */
  async ingestRepository({ owner, name, branch }) {
    if (!owner || typeof owner !== "string") throw new Error("owner is required");
    if (!name || typeof name !== "string") throw new Error("name is required");

    // 1. Fetch repo metadata
    let repoData;
    try {
      const res = await this.octokit.rest.repos.get({
        owner,
        repo: name,
      });
      repoData = res.data;
    } catch (err) {
      this._handleOctokitError(err, `repository ${owner}/${name}`);
    }

    const targetBranch = branch || repoData.default_branch;
    if (!targetBranch) {
      throw new Error(`Repository ${owner}/${name} has no default branch`);
    }

    // 2. Resolve commit SHA for the target branch
    let commitSha;
    try {
      const commitRes = await this.octokit.rest.repos.getCommit({
        owner,
        repo: name,
        ref: targetBranch,
      });
      commitSha = commitRes.data.sha;
    } catch (err) {
      this._handleOctokitError(err, `branch ${targetBranch} in ${owner}/${name}`);
    }

    // 3. Fetch git tree recursively
    let treeItems = [];
    try {
      const treeRes = await this.octokit.rest.git.getTree({
        owner,
        repo: name,
        tree_sha: commitSha,
        recursive: "1",
      });
      treeItems = treeRes.data.tree || [];
      if (treeRes.data.truncated) {
        // Warn if truncated
        console.warn(`Repository tree for ${owner}/${name}@${commitSha} was truncated by GitHub API`);
      }
    } catch (err) {
      this._handleOctokitError(err, `git tree for ${owner}/${name}@${commitSha}`);
    }

    // 4. Filter eligible files
    const eligibleTreeItems = [];
    let accumulatedBytes = 0;

    for (const item of treeItems) {
      if (item.type !== "blob") continue;
      const size = item.size || 0;

      if (!isEligibleFile(item.path, size)) {
        continue;
      }

      if (accumulatedBytes + size > this.maxTotalBytes) {
        break; // Reached total size threshold
      }

      eligibleTreeItems.push(item);
      accumulatedBytes += size;

      if (eligibleTreeItems.length >= this.maxFileCount) {
        break; // Reached max file count
      }
    }

    // 5. Fetch contents for each eligible file
    const files = [];
    for (const item of eligibleTreeItems) {
      try {
        const blobRes = await this.octokit.rest.git.getBlob({
          owner,
          repo: name,
          file_sha: item.sha,
        });

        const rawContent = blobRes.data.content;
        const encoding = blobRes.data.encoding;

        let content = "";
        if (encoding === "base64") {
          content = Buffer.from(rawContent, "base64").toString("utf-8");
        } else {
          content = rawContent || "";
        }

        files.push({
          filePath: item.path,
          content,
          blobSha: item.sha,
          commitSha,
          size: item.size || content.length,
        });
      } catch (err) {
        // Log individual file retrieval failure and continue
        console.warn(`Failed to fetch blob for file ${item.path}: ${err.message}`);
      }
    }

    return {
      repository: {
        owner: repoData.owner.login,
        name: repoData.name,
        fullName: repoData.full_name,
        htmlUrl: repoData.html_url,
        defaultBranch: repoData.default_branch,
      },
      branch: targetBranch,
      commitSha,
      files,
    };
  }

  _handleOctokitError(err, contextDescription) {
    const status = err.status || (err.response && err.response.status);
    if (status === 404) {
      throw new Error(`GitHub resource not found: ${contextDescription}`);
    }
    if (status === 403 || status === 429) {
      throw new Error(`GitHub API rate limit exceeded or access forbidden: ${contextDescription}`);
    }
    throw new Error(`GitHub API error (${status || "unknown"}): ${err.message || "Failed to communicate with GitHub"}`);
  }
}
