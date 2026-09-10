import { describe, it, expect } from 'vitest';
import { scrubContext, scrubString } from '../lib/log-scrubber';

const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const REFRESH = 'a'.repeat(40) + 'b'.repeat(40); // 80 lowercase hex

describe('scrubString', () => {
  it('redacts a JWT anywhere in a string', () => {
    expect(scrubString(`Bearer ${JWT}`)).toBe('Bearer ****');
    expect(scrubString(`token=${JWT}&other=x`)).toBe('token=****&other=x');
  });

  it('redacts an 80-hex refresh token', () => {
    expect(scrubString(`Bearer ${REFRESH}`)).toBe('Bearer ****');
  });

  it('leaves version-style dotted identifiers alone', () => {
    // The pre-fix pattern matched three dot-separated base64url segments of
    // any content — this build-stamp shape was a false positive.
    expect(scrubString('kinkane-server 20260101.abc12345.f00dcafe was built')).toBe(
      'kinkane-server 20260101.abc12345.f00dcafe was built',
    );
    expect(scrubString('version 2.1.0-beta.1')).toBe('version 2.1.0-beta.1');
  });

  it('leaves non-token strings alone', () => {
    expect(scrubString('requestId 550e8400-e29b-41d4-a716-446655440000')).toBe(
      'requestId 550e8400-e29b-41d4-a716-446655440000',
    );
    // Uppercase hex is not what randomBytes(40).toString('hex') produces, so
    // over-scrubbing SHA-like uppercase strings would be a false positive.
    expect(scrubString('SHA ' + 'A'.repeat(80))).toBe('SHA ' + 'A'.repeat(80));
    // 64-char SHA-256 is under the 80-hex refresh-token floor.
    expect(scrubString('sha ' + 'a'.repeat(64))).toBe('sha ' + 'a'.repeat(64));
  });
});

describe('scrubContext', () => {
  it('walks nested plain objects', () => {
    const input = { req: { headers: { accept: `json ${JWT}` } } };
    expect(scrubContext(input)).toEqual({
      req: { headers: { accept: 'json ****' } },
    });
  });

  it('redacts a whole value when its key names a credential', () => {
    // `authorization` is hidden by name, so the `Bearer ` prefix goes too —
    // stronger than the pattern rule, which would have left it in place.
    const input = { req: { headers: { authorization: `Bearer ${JWT}` } } };
    expect(scrubContext(input)).toEqual({
      req: { headers: { authorization: '****' } },
    });
  });

  it('walks arrays', () => {
    expect(scrubContext({ items: [REFRESH, 'not-a-token'] })).toEqual({
      items: ['****', 'not-a-token'],
    });
  });

  it('redacts an array wholesale when its key names a credential', () => {
    expect(scrubContext({ tokens: [REFRESH, 'not-a-token'] })).toEqual({
      tokens: '****',
    });
  });

  it('walks class instances so tokens on carrier objects are still redacted', () => {
    class Carrier {
      constructor(public token: string) {}
    }
    const input = { carrier: new Carrier(REFRESH) };
    expect(scrubContext(input)).toEqual({ carrier: { token: '****' } });
  });

  it('walks null-prototype objects (Express 5 req.query is one of these)', () => {
    const nullProto = Object.create(null) as Record<string, unknown>;
    nullProto.accept = `json ${JWT}`;
    expect(scrubContext({ req: { query: nullProto } })).toEqual({
      req: { query: { accept: 'json ****' } },
    });
  });

  it('walks an Error so a token in its message is redacted', () => {
    const err = new Error(`unauthorized: Bearer ${JWT}`);
    const scrubbed = scrubContext({ error: err.message, stack: err.stack });
    expect(scrubbed.error).toBe('unauthorized: Bearer ****');
    expect(scrubbed.stack).toContain('****');
    expect(scrubbed.stack).not.toContain(JWT);
  });

  it('replaces a cyclic reference with [Circular] instead of blowing the stack', () => {
    const cyclic: Record<string, unknown> = { name: 'foo' };
    cyclic.self = cyclic;
    // Before the fix this threw RangeError: Maximum call stack size exceeded.
    expect(() => scrubContext(cyclic)).not.toThrow();
    expect(scrubContext(cyclic)).toEqual({ name: 'foo', self: '[Circular]' });
  });

  it('replaces a cyclic array element with [Circular]', () => {
    const arr: unknown[] = [];
    arr.push(arr);
    expect(() => scrubContext(arr)).not.toThrow();
    expect(scrubContext(arr)).toEqual(['[Circular]']);
  });

  it('leaves primitives untouched', () => {
    expect(scrubContext(42)).toBe(42);
    expect(scrubContext(true)).toBe(true);
    expect(scrubContext(null)).toBeNull();
    expect(scrubContext(undefined)).toBeUndefined();
  });
});

describe('scrubContext — request payloads', () => {
  it('hides credentials no pattern could recognise', () => {
    const body = {
      email: 'reader@example.com',
      password: 'hunter2',
      otp: '481920',
      newPassword: 'correct horse',
    };
    expect(scrubContext({ body })).toEqual({
      body: {
        email: 'reader@example.com',
        password: '****',
        otp: '****',
        newPassword: '****',
      },
    });
  });

  it('hides a credential nested under a sensitive key rather than descending', () => {
    const body = { token: { raw: 'abc', hash: 'def' } };
    expect(scrubContext({ body })).toEqual({ body: { token: '****' } });
  });

  it('keeps the fields that make a payload worth logging', () => {
    // `code` and `reference` are deliberately not sensitive keys — see
    // SENSITIVE_KEYS.
    const body = {
      contactEmail: 'reader@example.com',
      reference: 'ORD-K7M2QX4P',
      referralCode: 'ABCD12',
      lines: [{ bookId: 42, quantity: 2 }],
    };
    expect(scrubContext({ body })).toEqual({ body });
  });

  it('summarises a Buffer instead of walking it byte by byte', () => {
    expect(scrubContext({ body: Buffer.from('hello') })).toEqual({
      body: '[Buffer 5 bytes]',
    });
  });
});
