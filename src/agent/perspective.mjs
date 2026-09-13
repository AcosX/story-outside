const QUOTED_SPANS = /[「『“"'][^「』“”"']*[」』”"']|（[^）]*）|\([^)]*\)/g;

// Compounds that merely CONTAIN 我 or 你 without being a narrating pronoun.
// Without these, ordinary prose like 「我们之间」 or 「自我怀疑」 fails a
// second-person track and silently degrades that role to the neutral base.
const PRONOUN_FALSE_POSITIVES = [
  '我们', '自我', '忘我', '我行我素', '你们', '你死我活', '你来我往', '你追我赶',
];

/**
 * Strip quoted spans and pronoun-bearing compounds, then report whether the
 * remaining narration actually uses `pronoun` as a narrating pronoun.
 *
 * @param {string} text
 * @param {'我' | '你'} pronoun
 * @returns {boolean}
 */
export function narratesWith(text, pronoun) {
  let stripped = text.replace(QUOTED_SPANS, '');
  for (const term of PRONOUN_FALSE_POSITIVES) stripped = stripped.split(term).join('');
  return stripped.includes(pronoun);
}
