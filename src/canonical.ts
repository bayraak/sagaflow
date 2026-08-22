/**
 * A canonical rendering of a value, and a stable hash of it.
 *
 * Used only by `idempotency: true`, where the key is "this exact input, once". Key order in an
 * object is not meaning — `{ a, b }` and `{ b, a }` are the same request — so the rendering
 * sorts keys at every depth before hashing.
 *
 * The hash is FNV-1a, 64-bit. Not cryptographic and not trying to be: nothing here is a secret,
 * and the only property that matters is that the same input produces the same key on every
 * runtime and every version. Declare an `idempotency` function instead when you want to control
 * the key exactly, which is the right answer whenever the key means something to somebody else.
 */
export const canonicalise = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'

  if (Array.isArray(value)) return `[${value.map((item) => canonicalise(item)).join(',')}]`

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalise(item)}`)

  return `{${entries.join(',')}}`
}

const offsetBasis = 0xcbf2_9ce4_8422_2325n
const prime = 0x0000_0100_0000_01b3n
const mask = 0xffff_ffff_ffff_ffffn

export const stableHash = (value: unknown): string => {
  const rendered = canonicalise(value)
  let hash = offsetBasis

  for (let index = 0; index < rendered.length; index += 1) {
    hash ^= BigInt(rendered.charCodeAt(index))
    hash = (hash * prime) & mask
  }

  return hash.toString(16).padStart(16, '0')
}
