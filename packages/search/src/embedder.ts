/**
 * Turns text into vectors for semantic search. `@cslug/ai` binds one from `config/ai.ts` → `embeddings`; tests can
 * bind a `FakeEmbedder`. `model` identifies the vectors: when it changes, documents are embedded again.
 */
export abstract class Embedder {
  abstract readonly model: string
  /** One vector per text, in order. `purpose` lets models that tell queries from documents (Voyage) do so. */
  abstract embed(texts: string[], purpose: 'document' | 'query'): Promise<number[][]>
}

const fold = (word: string) =>
  word
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/(ing|es|s)$/, '')

/**
 * A deterministic embedder for tests and development: words (lowercased, accents and a plural or -ing removed) are
 * hashed into `dimensions` buckets, so texts that share words are close. `concepts` maps words to a shared concept,
 * so a test can show matches by meaning (`{ car: 'vehicle', '4x4': 'vehicle' }`).
 */
export class FakeEmbedder extends Embedder {
  readonly model: string
  readonly calls: { texts: string[]; purpose: 'document' | 'query' }[] = []

  constructor(private readonly options: { dimensions?: number; concepts?: Record<string, string> } = {}) {
    super()
    this.model = `fake-${options.dimensions ?? 64}`
  }

  async embed(texts: string[], purpose: 'document' | 'query'): Promise<number[][]> {
    this.calls.push({ texts, purpose })
    const size = this.options.dimensions ?? 64
    return texts.map((text) => {
      const vector = new Array<number>(size).fill(0)
      for (const raw of text.split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
        const word = fold(raw)
        const token = this.options.concepts?.[word] ?? word
        const bucket = Number(BigInt(Bun.hash(token)) % BigInt(size))
        vector[bucket] = (vector[bucket] ?? 0) + 1
      }
      const norm = Math.hypot(...vector) || 1
      return vector.map((x) => x / norm)
    })
  }
}
