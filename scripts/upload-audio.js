const fs=require('fs');
const path=require('path');
const tcb=require('@cloudbase/node-sdk');

const root=path.resolve(process.argv[2]||path.join(__dirname,'..','server_assets','v0.2.0'));
const outFile=path.join(__dirname,'..','config','audio-files.json');
const env=process.env.CLOUDBASE_ENV_ID;
if(!env){console.error('缺少 CLOUDBASE_ENV_ID');process.exit(2);}
const opts={env,timeout:60000};
if(process.env.TENCENTCLOUD_SECRETID&&process.env.TENCENTCLOUD_SECRETKEY){opts.secretId=process.env.TENCENTCLOUD_SECRETID;opts.secretKey=process.env.TENCENTCLOUD_SECRETKEY;}
const app=tcb.init(opts);
function walk(dir){let out=[];for(const name of fs.readdirSync(dir)){const p=path.join(dir,name),s=fs.statSync(p);if(s.isDirectory())out=out.concat(walk(p));else out.push(p);}return out;}
(async()=>{
  if(!fs.existsSync(root)){console.error('找不到音频目录:',root);process.exit(2);}
  const files=walk(root),manifest={};
  for(let i=0;i<files.length;i++){
    const file=files[i],rel=path.relative(root,file).split(path.sep).join('/'),cloudPath=`healtools/audio/v0.4.0/${rel}`;
    const r=await app.uploadFile({cloudPath,fileContent:fs.createReadStream(file)});
    manifest[rel]=r.fileID;
    console.log(`[${i+1}/${files.length}] ${rel}`);
  }
  fs.writeFileSync(outFile,JSON.stringify(manifest,null,2)+'\n');
  console.log('完成，已写入',outFile);
})().catch(e=>{console.error(e);process.exit(1);});
