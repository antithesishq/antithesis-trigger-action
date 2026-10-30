import * as core from '@actions/core'
import * as tool_cache from '@actions/tool-cache'
import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import * as path from 'node:path'

// TODO: bump to 0.9.0 once it is released; `runs stream` first shipped in
// 0.9.0-rc.1, which is why the default is a pre-release.
export const DEFAULT_SNOUTY_VERSION = '0.9.0-rc.1'

export const SNOUTY_RELEASES_URL =
  'https://github.com/antithesishq/snouty/releases/download'

/** The slice of `@actions/tool-cache` this module uses, for test doubles. */
export interface ToolCache {
  find: (tool: string, version: string, arch?: string) => string
  downloadTool: (url: string) => Promise<string>
  extractTar: (
    file: string,
    dest?: string,
    flags?: string | string[]
  ) => Promise<string>
  cacheDir: (
    source_dir: string,
    tool: string,
    version: string,
    arch?: string
  ) => Promise<string>
}

export interface InstallOptions {
  version: string
  /** A snouty binary already on the runner; skips the download entirely. */
  preinstalled_path?: string
  platform?: NodeJS.Platform
  arch?: string
  tool_cache?: ToolCache
  read_file?: (file: string) => Promise<string>
  file_exists?: (file: string) => Promise<boolean>
  add_path?: (dir: string) => void
}

/**
 * The cargo-dist target triple of the release archive for this runner. From
 * 0.9.0 the Linux builds are static musl only.
 */
export function release_triple(
  platform: NodeJS.Platform,
  arch: string
): string {
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-musl'
  if (platform === 'linux' && arch === 'arm64')
    return 'aarch64-unknown-linux-musl'
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin'
  throw new Error(
    `No snouty release for ${platform}/${arch}; set the snouty_path input to a preinstalled binary.`
  )
}

export function release_url(version: string, triple: string): string {
  return `${SNOUTY_RELEASES_URL}/v${version}/snouty-${triple}.tar.xz`
}

/** The hex digest in a `.sha256` file, whatever follows it (dist writes "<hex>  <file>"). */
export function parse_sha256_file(text: string): string {
  const [first] = text.trim().split(/\s+/)
  const digest = (first ?? '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error(
      'The snouty checksum file does not contain a SHA-256 digest.'
    )
  }
  return digest
}

async function sha256_of_file(file: string): Promise<string> {
  const buffer = await readFile(file)
  return createHash('sha256').update(buffer).digest('hex')
}

async function default_file_exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

/**
 * Return the path of a snouty binary of `version`, downloading and caching the
 * release archive when the runner's tool cache does not have it yet.
 */
export async function ensure_snouty(opts: InstallOptions): Promise<string> {
  if (opts.preinstalled_path) {
    core.info(`Using the preinstalled snouty at ${opts.preinstalled_path}`)
    return opts.preinstalled_path
  }

  const tc = opts.tool_cache ?? tool_cache
  const file_exists = opts.file_exists ?? default_file_exists
  const read_file =
    opts.read_file ?? (async (file: string) => readFile(file, 'utf8'))
  const add_path = opts.add_path ?? core.addPath
  const platform = opts.platform ?? process.platform
  const arch = opts.arch ?? process.arch
  const triple = release_triple(platform, arch)

  const cached = tc.find('snouty', opts.version, triple)
  if (cached) {
    core.info(`Using cached snouty ${opts.version} from ${cached}`)
    add_path(cached)
    return path.join(cached, 'snouty')
  }

  const url = release_url(opts.version, triple)
  core.info(`Downloading snouty ${opts.version} from ${url}`)
  const archive = await tc.downloadTool(url)
  const checksum_file = await tc.downloadTool(`${url}.sha256`)
  const expected = parse_sha256_file(await read_file(checksum_file))
  const actual = await sha256_of_file(archive)
  if (actual !== expected) {
    throw new Error(
      `snouty download checksum mismatch: expected ${expected}, got ${actual}`
    )
  }

  const extracted = await tc.extractTar(archive, undefined, 'xJ')
  // dist archives wrap the binary in a directory named after the archive;
  // accept a flat layout too in case that changes.
  const candidates = [
    path.join(extracted, 'snouty'),
    path.join(extracted, `snouty-${triple}`, 'snouty')
  ]
  let binary_dir: string | undefined
  for (const candidate of candidates) {
    if (await file_exists(candidate)) {
      binary_dir = path.dirname(candidate)
      break
    }
  }
  if (binary_dir === undefined) {
    throw new Error(
      `The snouty archive did not contain a snouty binary (looked in ${candidates.join(', ')})`
    )
  }

  const cache_dir = await tc.cacheDir(
    binary_dir,
    'snouty',
    opts.version,
    triple
  )
  add_path(cache_dir)
  return path.join(cache_dir, 'snouty')
}
