// Conservative catalog matching: evidence comes only from official metadata.
// This intentionally sacrifices recall; no LLM guesses or genre-only matches.
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
const GENERIC = new Set(('故事 小说 作品 作者 读者 主角 人生 生活 世界 时间 时候 事情 发生 发现 觉得 知道 可以 可能 不能 需要 为什么 如何 什么 一个 一种 一次 一切 一起 自己 我们 他们 她们 你们 没有 不是 还是 就是 但是 因为 所以 之后 之前 最后 现在 未来 曾经 终于 开始 结束 选择 关系 问题 影响 原因 方式 结果 意义 评价 认为 现实 社会 家庭 爱情 亲情 友情 情感 感情 爱人 恋爱 婚姻 都市 言情 青春 成长 女性 男性 女人 男人 孩子 父母 朋友 同学 工作 职场 校园 悬疑 推理 科幻 奇幻 历史 古代 现代 爽文 短篇 长篇 浪漫 治愈 逆袭 重生 穿越 人性 命运 秘密 真相 危机 挑战 带来 成为 面对 得到 失去 以及 进行 出现 通过 这个 那个 这样 那样 这些 那些 很多 所有 任何 每个 已经 一直 一名 一位').split(' '));
const normalize = (text) => typeof text === 'string' ? text.normalize('NFKC').toLowerCase().trim() : '';

function terms(text) {
  const parts = [...segmenter.segment(normalize(text))];
  const words = parts.filter((part) => part.isWordLike).map((part) => part.segment);
  // ICU splits some concrete nouns (宇航/员, 空间/站). Preserve these
  // adjacent noun suffixes without manufacturing arbitrary character ngrams.
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i].isWordLike && parts[i].segment.length >= 2 && /^[员站馆舰症]$/.test(parts[i + 1].segment)) {
      words.push(parts[i].segment + parts[i + 1].segment);
    }
  }
  return [...new Set(words
    .filter((word) => word.length >= 2 && !GENERIC.has(word) && !/^\d+$/.test(word)))];
}

function match(entry, story) {
  const title = normalize(story.title).replace(/[《》]/g, '');
  const hotTitle = normalize(entry.title);
  const hotText = `${hotTitle} ${normalize(entry.excerpt)}`;
  const categories = (story.categories || story.labels || story.source?.labels || []).filter((x) => typeof x === 'string');
  const storyText = `${story.title || ''} ${story.description || story.hook || ''} ${categories.join(' ')}`;
  // A full title is evidence only when explicitly named as a work, or when
  // sufficiently long and containing multiple specific words.
  if (title.length >= 4 && terms(title).length >= 2 &&
      (hotText.includes(`《${title}》`) || (title.length >= 8 && hotText.includes(title)))) {
    return { matched_terms: [story.title], matched_reason: `热点明确提及《${story.title}》` };
  }
  const hotTerms = new Set(terms(hotText));
  const matched = terms(storyText).filter((term) => hotTerms.has(term));
  // Substring variants cannot count as independent evidence.
  const independent = matched.filter((term) => !matched.some((other) => other !== term && other.includes(term)));
  const totalLength = independent.reduce((sum, term) => sum + term.length, 0);
  const specificAnchor = independent.some((term) => term.length >= 3 && terms(hotTitle).includes(term));
  if (independent.length < 3 || totalLength < 8 || !specificAnchor) return null;
  return { matched_terms: independent, matched_reason: `故事简介与热点共同涉及：${independent.join('、')}` };
}

export function matchHotToStoryCatalog(response, catalog) {
  const stories = Array.isArray(catalog) ? catalog.filter((story) => story && typeof story.id === 'string' && typeof story.title === 'string') : [];
  const hot = (Array.isArray(response.hot) ? response.hot : []).flatMap((entry) => {
    const related_stories = stories.flatMap((story) => {
      const evidence = match(entry, story);
      if (!evidence) return [];
      return [{ id: story.id, title: story.title,
        cover_url: story.cover_url || '',
        categories: (story.categories || story.labels || story.source?.labels || []).filter((value) => typeof value === 'string'),
        ...evidence }];
    });
    if (!related_stories.length) return [];
    return [{ ...entry, related_stories,
      matched_terms: [...new Set(related_stories.flatMap((story) => story.matched_terms))],
      matched_reason: related_stories.map((story) => `《${story.title}》：${story.matched_reason}`).join('；'),
    }];
  });
  return { ...response, hot, catalog_matched: true, match_policy: 'specific_metadata_terms_v1' };
}

export function projectProfileMatchedHot(response, story) {
  const hot = story ? (response.hot || []).filter((entry) => entry.relevant?.score > 0).map((entry) => {
    const matched_terms = entry.relevant.matched_terms.slice();
    const matched_reason = `与《${story.title}》的故事主题相关：${matched_terms.join('、')}`;
    return { ...entry, matched_terms, matched_reason, related_stories: [{
      id: story.slug || story.id, title: story.title, cover_url: story.cover_url || '',
      categories: Array.isArray(story.categories) ? story.categories : [], matched_terms, matched_reason,
    }] };
  }) : [];
  return { ...response, hot, catalog_matched: true };
}
