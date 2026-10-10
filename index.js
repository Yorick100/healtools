const express = require('express');
const crypto = require('crypto');
const db = require('./src/db');
const { register } = require('./src/routes');

const app = express();
app.disable('x-powered-by');
app.use(express.json({limit:'256kb'}));
app.use((req,res,next)=>{const id=String(req.headers['x-request-id']||crypto.randomUUID());req.requestId=id;res.set('X-Request-ID',id);res.set('Cache-Control','no-store');next();});
app.use((req,res,next)=>{const started=Date.now();if(req.path.startsWith('/admin'))console.info('[admin] incoming',JSON.stringify({path:req.path,request_id:req.requestId}));res.on('finish',()=>console.log(JSON.stringify({ts:new Date().toISOString(),method:req.method,path:req.path,status:res.statusCode,elapsed_ms:Date.now()-started,request_id:req.requestId,source:req.headers['x-wx-source']||'',platform:req.headers['x-wx-platform']||'',client_version:String(req.headers['x-healtools-app-version']||'').slice(0,20)})));next();});
register(app);
app.use((req,res)=>res.status(404).json({code:'not_found',message:'接口不存在'}));
app.use((err,req,res,next)=>{console.error(JSON.stringify({ts:new Date().toISOString(),request_id:req.requestId,error:String(err?.message||err),stack:process.env.NODE_ENV==='production'?undefined:err?.stack}));res.status(Number(err.status||500)).json({code:err.code||'service_error',message:Number(err.status||500)>=500?'服务暂时不可用':String(err.message||'请求失败'),data:{retryable:Number(err.status||500)>=500,request_id:req.requestId}});});

const port=Number(process.env.PORT||80);
(async()=>{try{if(process.env.AUTO_MIGRATE!=='0')await db.migrate();app.listen(port,'0.0.0.0',()=>console.log(`HEALTOOLS CloudRun v0.5.3-ugc1 listening on ${port}`));}catch(e){console.error('startup failed',e);process.exit(1);}})();
