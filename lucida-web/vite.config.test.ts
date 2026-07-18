import { describe, expect, it } from 'vitest'
import { resolveDevProxyTarget } from './vite.config'

describe('resolveDevProxyTarget', () => {
  it('uses the loopback backend by default', () => {
    expect(resolveDevProxyTarget({})).toBe('http://127.0.0.1:9876')
  })

  it('accepts a configurable HTTP(S) origin for parallel dev instances', () => {
    expect(resolveDevProxyTarget({ LUCIDA_VITE_PROXY_TARGET: 'http://localhost:9988' }))
      .toBe('http://localhost:9988')
    expect(resolveDevProxyTarget({ LUCIDA_VITE_PROXY_TARGET: 'https://dev.example.test:9443/' }))
      .toBe('https://dev.example.test:9443')
  })

  it('rejects ambiguous or unsafe proxy targets', () => {
    expect(() => resolveDevProxyTarget({ LUCIDA_VITE_PROXY_TARGET: 'localhost:9988' })).toThrow(
      /absolute HTTP\(S\) URL/,
    )
    expect(() => resolveDevProxyTarget({ LUCIDA_VITE_PROXY_TARGET: 'ws://localhost:9988' })).toThrow(
      /must use http or https/,
    )
    expect(() => resolveDevProxyTarget({ LUCIDA_VITE_PROXY_TARGET: 'http://user:secret@localhost:9988/api' })).toThrow(
      /credential-free origin/,
    )
  })
})
