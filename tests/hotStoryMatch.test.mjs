import assert from 'node:assert/strict';
import { matchHotToStoryCatalog, projectProfileMatchedHot } from '../src/providers/ecosystem/hotStoryMatch.mjs';

const story = {id:'space',title:'星际救援计划',description:'宇航员在空间站遭遇氧气泄漏。',cover_url:'https://pic1.zhimg.com/a.jpg',categories:['科幻']};
const input = {hot:[
  {title:'宇航员如何应对空间站的氧气泄漏？',excerpt:'应急救援',rank:1},
  {title:'为什么爱情故事影响人生？',excerpt:'生活、家庭与未来',rank:2},
  {title:'空间站的最新照片',excerpt:'',rank:3},
]};
const result = matchHotToStoryCatalog(input,[story]);
assert.equal(result.hot.length,1);
assert.equal(result.hot[0].related_stories[0].id,'space');
assert.equal(result.hot[0].related_stories[0].cover_url,story.cover_url);
assert.ok(result.hot[0].matched_terms.includes('宇航员'));
assert.ok(result.hot[0].matched_terms.includes('空间站'));
assert.ok(result.hot[0].matched_reason.includes('星际救援计划'));
assert.equal(input.hot.length,3,'does not mutate cached upstream');
assert.equal(matchHotToStoryCatalog(input,[]).hot.length,0);
assert.equal(matchHotToStoryCatalog({hot:[{title:'爱情与人生，未来和家庭',excerpt:''}]},[{id:'generic',title:'爱情人生',description:'家庭和未来，生活故事',categories:['爱情']}]).hot.length,0);
assert.equal(matchHotToStoryCatalog({hot:[{title:'如何评价《星际救援计划》？',excerpt:''}]},[story]).hot.length,1);
assert.equal(matchHotToStoryCatalog({hot:[{title:'空间站的最新照片',excerpt:'宇航员'}]},[story]).hot.length,0,'two isolated terms are insufficient');
assert.equal(matchHotToStoryCatalog({hot:[{title:'最新消息',excerpt:'宇航员在空间站发现氧气泄漏'}]},[story]).hot.length,0,'specific evidence must anchor in hot title');
console.log('hotStoryMatch: positive evidence, generic and weak overlap rejection, explicit title, catalog-only projection passed');
const profileResult = projectProfileMatchedHot({hot:[{title:'related',relevant:{score:1,matched_terms:['空间站']}},{title:'unrelated',relevant:{score:0,matched_terms:[]}}]},story);
assert.equal(profileResult.hot.length,1);
assert.equal(profileResult.hot[0].related_stories[0].id,'space');
assert.deepEqual(projectProfileMatchedHot({hot:input.hot},story).hot,[]);
assert.deepEqual(projectProfileMatchedHot({hot:input.hot},undefined).hot,[]);
