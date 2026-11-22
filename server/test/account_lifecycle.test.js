const test=require('node:test');
const assert=require('node:assert/strict');
const {Wallet}=require('../src/wallet');
const {PostgresWallet}=require('../src/postgres_wallet');
const {PGlite}=require('@electric-sql/pglite');
const {Social}=require('../src/social');
const {Management}=require('../src/management');
const {AccountLifecycle}=require('../src/account_lifecycle');
const {deletionPage,privacyPage}=require('../src/public_pages');

for(const pg of [false,true]) test(`${pg?'PostgreSQL':'SQLite'} self-deletion verifies password and confirmation and removes identity`,async()=>{
  let w,close;
  if(pg) {
    const db=new PGlite();w=new PostgresWallet({query:(sql,args)=>db.query(sql,args),connect:async()=>({query:(sql,args)=>db.query(sql,args),release(){}}),end:()=>db.close()});
    w.db.exec=sql=>db.exec(sql);await w.initialize();close=()=>db.close();
  } else {w=new Wallet(':memory:');close=()=>w.db.close();}
  try {
    const social=new Social(w);await social.initialize();
    const a=await w.register({email:'delete-me@example.test',name:'Delete Me',password:'test-pass-2026'});
    const b=await w.register({email:'friend@example.test',name:'Friend',password:'test-pass-2026'});
    await social.request(a.token,b.profile.playerCode);await social.respond(b.token,a.profile.id,true);
    const manager={rooms:new Map(),ctx:()=>null,leaveRoom(){}};
    const management=new Management(w,manager,{of:()=>({sockets:new Map()})},social.db);
    const life=new AccountLifecycle(w,management);
    assert.equal((await life.remove(a.token,'test-pass-2026','')).ok,false);
    assert.equal((await life.remove(a.token,'incorrect','SİL')).ok,false);
    assert.equal(await w.authenticate(a.token),a.profile.id);
    assert.equal((await life.remove(a.token,'test-pass-2026','SİL')).ok,true);
    assert.equal(await w.authenticate(a.token),null);
    assert.equal((await w.login({email:'delete-me@example.test',password:'test-pass-2026'})).ok,false);
    assert.equal(await social.db.get('SELECT code FROM player_codes WHERE account_id = ?',a.profile.id),undefined);
    assert.equal(Number((await social.db.get('SELECT COUNT(*) AS n FROM friendships')).n),0);
    assert.equal((await social.db.get('SELECT name FROM accounts WHERE id = ?',a.profile.id)).name,'Silinen Oyuncu');
    assert.equal((await life.removeWithCredentials('friend@example.test','test-pass-2026','SİL')).ok,true);
    assert.equal(await w.authenticate(b.token),null);
  } finally {await close();}
});
test('last manager must hand off management before self-deletion',async()=>{
  const w=new Wallet(':memory:');const social=new Social(w);await social.initialize();
  try {
    const a=w.register({email:'manager@example.test',name:'Manager',password:'test-pass-2026'});
    const b=w.register({email:'other@example.test',name:'Other',password:'test-pass-2026'});
    w.db.prepare('INSERT INTO managers VALUES(1,?)').run(a.profile.id);
    const m=new Management(w,{rooms:new Map(),ctx:()=>null,leaveRoom(){}},{of:()=>({sockets:new Map()})},social.db);
    const life=new AccountLifecycle(w,m);
    assert.equal((await life.remove(a.token,'test-pass-2026','SİL')).ok,false);
    assert.equal(w.isManager(a.profile.id),true);
    w.db.prepare('INSERT INTO managers VALUES(2,?)').run(b.profile.id);
    assert.equal((await life.remove(a.token,'test-pass-2026','SİL')).ok,true);
    assert.equal(w.isManager(b.profile.id),true);
  } finally {w.db.close();}
});
test('public deletion page has safe password fields and escapes feedback',()=>{
  const html=deletionPage('<script>bad</script>');
  assert.equal(html.includes('<script>bad</script>'),false);
  assert.match(html,/method="post"/);assert.match(html,/type="password"/);
  assert.match(privacyPage(),/Bunny 101/);assert.match(privacyPage(),/a.yasirzeren23@gmail.com/);
});
