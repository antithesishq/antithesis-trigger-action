import * as core from '@actions/core'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  ensure_snouty,
  parse_sha256_file,
  release_triple,
  release_url,
  type ToolCache
} from '../src/snouty-install'

describe('release_triple / release_url', () => {
  it('picks the musl builds on Linux and the arm build on macOS', () => {
    expect(release_triple('linux', 'x64')).toBe('x86_64-unknown-linux-musl')
    expect(release_triple('linux', 'arm64')).toBe('aarch64-unknown-linux-musl')
    expect(release_triple('darwin', 'arm64')).toBe('aarch64-apple-darwin')
    expect(() => release_triple('win32', 'x64')).toThrow(/snouty_path/)
  })

  it('points at the versioned release asset', () => {
    expect(release_url('0.9.0-rc.1', 'x86_64-unknown-linux-musl')).toBe(
      'https://github.com/antithesishq/snouty/releases/download/v0.9.0-rc.1/snouty-x86_64-unknown-linux-musl.tar.xz'
    )
  })
})

describe('parse_sha256_file', () => {
  const digest = 'a'.repeat(64)
  it('accepts a bare digest or "digest  filename"', () => {
    expect(parse_sha256_file(`${digest}\n`)).toBe(digest)
    expect(parse_sha256_file(`${digest.toUpperCase()}  snouty.tar.xz`)).toBe(
      digest
    )
  })
  it('rejects anything else', () => {
    expect(() => parse_sha256_file('not a digest')).toThrow(/SHA-256/)
  })
})

describe('ensure_snouty', () => {
  let tc: jest.Mocked<ToolCache>
  let archive: string
  let archive_digest: string
  let extracted: string

  beforeEach(async () => {
    jest.spyOn(core, 'info').mockImplementation()
    const dir = await mkdtemp(path.join(tmpdir(), 'snouty-install-test-'))
    archive = path.join(dir, 'snouty.tar.xz')
    await writeFile(archive, 'pretend archive bytes')
    archive_digest = createHash('sha256')
      .update('pretend archive bytes')
      .digest('hex')
    extracted = path.join(dir, 'extracted')
    tc = {
      find: jest.fn().mockReturnValue(''),
      downloadTool: jest.fn(async (url: string) =>
        url.endsWith('.sha256') ? path.join(dir, 'checksum') : archive
      ),
      extractTar: jest.fn<
        Promise<string>,
        [string, string?, (string | string[])?]
      >(async () => extracted),
      cacheDir: jest.fn<Promise<string>, [string, string, string, string?]>(
        async () => '/toolcache/snouty/0.9.0-rc.1/x64'
      )
    }
  })

  it('returns a preinstalled binary without touching the cache', async () => {
    const binary = await ensure_snouty({
      version: '0.9.0-rc.1',
      preinstalled_path: '/usr/local/bin/snouty',
      tool_cache: tc
    })
    expect(binary).toBe('/usr/local/bin/snouty')
    expect(tc.find).not.toHaveBeenCalled()
  })

  it('uses the tool cache when it already has this version', async () => {
    tc.find.mockReturnValue('/toolcache/snouty/0.9.0-rc.1/x64')
    const add_path = jest.fn()
    const binary = await ensure_snouty({
      version: '0.9.0-rc.1',
      platform: 'linux',
      arch: 'x64',
      tool_cache: tc,
      add_path
    })
    expect(binary).toBe('/toolcache/snouty/0.9.0-rc.1/x64/snouty')
    expect(tc.downloadTool).not.toHaveBeenCalled()
    expect(add_path).toHaveBeenCalledWith('/toolcache/snouty/0.9.0-rc.1/x64')
  })

  it('downloads, verifies, extracts (nested layout) and caches', async () => {
    const add_path = jest.fn()
    const binary = await ensure_snouty({
      version: '0.9.0-rc.1',
      platform: 'linux',
      arch: 'x64',
      tool_cache: tc,
      add_path,
      read_file: async () =>
        `${archive_digest}  snouty-x86_64-unknown-linux-musl.tar.xz\n`,
      file_exists: async file =>
        file ===
        path.join(extracted, 'snouty-x86_64-unknown-linux-musl', 'snouty')
    })
    expect(tc.downloadTool).toHaveBeenCalledWith(
      'https://github.com/antithesishq/snouty/releases/download/v0.9.0-rc.1/snouty-x86_64-unknown-linux-musl.tar.xz'
    )
    expect(tc.extractTar).toHaveBeenCalledWith(archive, undefined, 'xJ')
    expect(tc.cacheDir).toHaveBeenCalledWith(
      path.join(extracted, 'snouty-x86_64-unknown-linux-musl'),
      'snouty',
      '0.9.0-rc.1',
      'x86_64-unknown-linux-musl'
    )
    expect(binary).toBe('/toolcache/snouty/0.9.0-rc.1/x64/snouty')
    expect(add_path).toHaveBeenCalledWith('/toolcache/snouty/0.9.0-rc.1/x64')
  })

  it('accepts a flat archive layout', async () => {
    await ensure_snouty({
      version: '0.9.0-rc.1',
      platform: 'linux',
      arch: 'arm64',
      tool_cache: tc,
      add_path: () => undefined,
      read_file: async () => archive_digest,
      file_exists: async file => file === path.join(extracted, 'snouty')
    })
    expect(tc.cacheDir).toHaveBeenCalledWith(
      extracted,
      'snouty',
      '0.9.0-rc.1',
      'aarch64-unknown-linux-musl'
    )
  })

  it('refuses a checksum mismatch and a binary-less archive', async () => {
    await expect(
      ensure_snouty({
        version: '0.9.0-rc.1',
        platform: 'linux',
        arch: 'x64',
        tool_cache: tc,
        add_path: () => undefined,
        read_file: async () => 'b'.repeat(64)
      })
    ).rejects.toThrow(/checksum mismatch/)
    expect(tc.extractTar).not.toHaveBeenCalled()

    await expect(
      ensure_snouty({
        version: '0.9.0-rc.1',
        platform: 'linux',
        arch: 'x64',
        tool_cache: tc,
        add_path: () => undefined,
        read_file: async () => archive_digest,
        file_exists: async () => false
      })
    ).rejects.toThrow(/did not contain a snouty binary/)
  })
})
