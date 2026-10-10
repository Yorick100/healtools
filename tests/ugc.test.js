'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createChecker,assessWechatResponse} = require('../src/ugc');

function fakeResponse(data,ok=true){return {ok,async json(){return data;}};}
const accepted={errcode:0,errmsg:'ok',result:{suggest:'pass',label:100}};

test('WeChat response must have explicit result.suggest=pass',()=>{
  assert.equal(assessWechatResponse(accepted),'pass');
  assert.equal(assessWechatResponse({errcode:0}),'unavailable');
  assert.equal(assessWechatResponse({errcode:0,result:{suggest:'risky'}}),'blocked');
  assert.equal(assessWechatResponse({errcode:0,result:{suggest:'review'}}),'review');
  assert.equal(assessWechatResponse({errcode:40001,result:{suggest:'pass'}}),'unavailable');
});

test('nickname is checked with scene 1 and OpenID in CloudRun proxy',async()=>{
  let target='',options;
  const check=createChecker({fetchImpl:async(url,opt)=>{target=url;options=opt;return fakeResponse(accepted);}});
  const result=await check({content:'  示例昵称  ',openid:'openid-test',scene:1});
  assert.equal(result.outcome,'pass');
  assert.equal(target,'http://api.weixin.qq.com/wxa/msg_sec_check');
  assert.deepEqual(JSON.parse(options.body),{openid:'openid-test',version:2,scene:1,content:'示例昵称'});
});

for(const [suggest,code] of [['risky','ugc_content_blocked'],['review','ugc_review_required']]){
  test(`${suggest} text must be rejected, not accepted`,async()=>{
    const check=createChecker({fetchImpl:async()=>fakeResponse({errcode:0,result:{suggest}})});
    await assert.rejects(check({content:'测试文字',openid:'openid-test',scene:2}),e=>e.code===code&&e.status===422);
  });
}

test('API failure, invalid shape, and transport exception all fail closed',async()=>{
  for(const impl of [async()=>fakeResponse({errcode:40001}),async()=>fakeResponse({errcode:0}),async()=>{throw new Error('network error');}]){
    const check=createChecker({fetchImpl:impl});
    await assert.rejects(check({content:'文本',openid:'openid-test',scene:2}),e=>e.code==='ugc_check_unavailable'&&e.status===503);
  }
});

test('empty quick-option text needs no check; oversized text is rejected',async()=>{
  const check=createChecker({fetchImpl:async()=>{throw new Error('must not call');}});
  assert.equal((await check({content:' ',openid:'openid-test',scene:2})).checked,false);
  await assert.rejects(check({content:'测'.repeat(2501),openid:'openid-test',scene:2}),e=>e.code==='ugc_input_invalid');
});
