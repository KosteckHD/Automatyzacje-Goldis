const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const base = __dirname;
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.jpg':'image/jpeg','.png':'image/png','.ttf':'font/ttf','.txt':'text/plain; charset=utf-8'};
const server = http.createServer((req,res)=>{
  const relative = decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.resolve(base,relative);
  if(!file.startsWith(base+path.sep)){res.writeHead(403);res.end();return;}
  fs.readFile(file,(error,data)=>{if(error){res.writeHead(404);res.end('Not found');return;}res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data);});
});
server.listen(Number(process.env.GOLDIS_MOCKUP_PORT||3445),'127.0.0.1',()=>console.log(`GOLDIS_MOCKUPS_READY http://127.0.0.1:${server.address().port}`));
