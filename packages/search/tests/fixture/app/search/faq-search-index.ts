import { searchIndex } from '../../../../src'

/** What `search:reindex` refills in the tests: `faqDocuments` is set by the test before each run. */
export const faqDocuments: { key: string; title: string; body: string }[] = []

export const faqIndex = searchIndex('faq', {
  languages: ['french'],
  documents: function* () {
    yield* faqDocuments
  },
})
