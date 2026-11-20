const test = require('node:test');
const assert = require('node:assert/strict');
const {Wallet} = require('../src/wallet');
const {PostgresWallet} = require('../src/postgres_wallet');
const {PGlite} = require('@electric-sql/pglite');
const {Social} = require('../src/social');
const {Management} = require('../src/management');
const schema = require('../src/management_schema');

async function fixture(pg) {
  let wallet, close;
  if (pg) {
    const db = new PGlite();
    wallet = new PostgresWallet({query:(sql,args)=>db.query(sql,args),connect:async()=>({query:(sql,args)=>db.query(sql,args),release(){}}),end:()=>db.close()});
    wallet.db.exec=(sql)=>db.exec(sql);
    await wallet.initialize();
    // A single PGlite connection cannot represent concurrent BEGINs; serialize
    // its transactions like independent PostgreSQL clients waiting on the lock.
    const transaction=wallet.db.transaction.bind(wallet.db); let queue=Promise.resolve();
    wallet.db.transaction=(fn)=>{const run=queue.then(()=>transaction(fn));queue=run.catch(()=>{});return run;};
    close=()=>db.close();
  } else { wallet=new Wallet(':memory:'); close=()=>wallet.db.close(); }
  const social=new Social(wallet); await social.initialize();
  const users=[];
  for(let i=0;i<5;i++) users.push(await wallet.register({email:i===0?'a.yasirzeren23@gmail.com':`m${i}@example.test`,name:`Player ${i}`,password:'test-password-2026'}));
  // Simulate the first upgrade of a database with an existing primary account.
  await social.db.run('DELETE FROM management_migrations'); if(pg) await wallet.initialize(); else await social.db.exec(schema);
  const sockets=new Map();
  const rooms=new Map();
  const manager={rooms,blockedAccounts:new Set(),ctx:()=>null,leaveRoom(){}};
  const io={of:()=>({sockets})};
  const management=new Management(wallet,manager,io,social.db);
  return {wallet,users,social,manager,sockets,management,close};
}

for(const pg of [false,true]) test(`${pg?'PostgreSQL':'SQLite'} manager roles, cap, authorization and account controls`,async()=>{
  const f=await fixture(pg); const {wallet,users,social,management}=f;
  let n=0;
  const act=(actor,target,action,reason='QA')=>management.action(actor.token,{target:target.profile.id,action,reason,requestId:(++n).toString(16).padStart(32,'0')});
  try {
    assert.equal(await wallet.isManager(users[0].profile.id),true);
    assert.equal((await wallet.account(users[0].token)).profile.isManager,true);
    assert.equal((await wallet.account(users[1].token)).profile.isManager,false);
    assert.equal((await management.stats(users[1].token)).ok,false);
    assert.equal((await act(users[0],users[1],'admin_grant')).ok,true);
    assert.equal(await wallet.isAdmin(users[1].profile.id),true);
    assert.equal((await management.lookup(users[1].token,'m2@example.test')).ok,false);
    assert.equal((await act(users[1],users[2],'manager_grant')).ok,false);
    assert.equal((await act(users[1],users[2],'ban')).ok,false);
    assert.equal((await management.lookup(users[0].token,users[2].profile.playerCode)).target.playerCode,users[2].profile.playerCode);
    const managerInfo=await management.lookup(users[0].token,'a.yasirzeren23@gmail.com');
    assert.equal(managerInfo.target.isManager,true); assert.equal(managerInfo.target.isAdmin,true);
    const grants=await Promise.all([act(users[0],users[2],'manager_grant'),act(users[0],users[3],'manager_grant')]);
    assert.equal(grants.filter(r=>r.ok).length,1);
    assert.equal(Number((await social.db.get('SELECT COUNT(*) AS n FROM managers')).n),2);
    const second=(await wallet.isManager(users[2].profile.id))?users[2]:users[3];
    assert.equal((await act(users[0],second,'ban')).ok,false);
    assert.equal((await act(users[0],second,'delete')).ok,false);
    assert.equal((await act(users[0],users[4],'ban','')).ok,false);
    assert.equal((await act(users[0],users[4],'ban')).ok,true);
    assert.equal(await wallet.authenticate(users[4].token),null);
    assert.equal((await wallet.login({email:'m4@example.test',password:'test-password-2026'})).ok,false);
    assert.equal((await act(users[0],users[4],'unban')).ok,true);
    assert.equal((await wallet.login({email:'m4@example.test',password:'test-password-2026'})).ok,true);
    const data={target:users[4].profile.id,action:'delete',reason:'QA deletion',requestId:'f'.repeat(32)};
    assert.equal((await management.action(users[0].token,data)).ok,true);
    assert.equal((await management.action(users[0].token,data)).ok,true);
    const deleted=await social.db.get('SELECT email,name FROM accounts WHERE id = ?',users[4].profile.id);
    assert.equal(deleted.name,'Silinen Oyuncu'); assert.notEqual(deleted.email,'m4@example.test');
    assert.equal(Number((await social.db.get('SELECT COUNT(*) AS n FROM management_audit WHERE request_id = ?',data.requestId)).n),1);
    assert.equal((await management.action(users[0].token,{...data,reason:'different'})).ok,false);
  } finally {await f.close();}
});

test('new signup cannot claim bootstrap manager email after migration',()=>{
  const wallet=new Wallet(':memory:');
  try {
    const user=wallet.register({email:'a.yasirzeren23@gmail.com',name:'Late signup',password:'test-password-2026'});
    assert.equal(wallet.isManager(user.profile.id),false);
    wallet.db.exec(schema);
    assert.equal(wallet.isManager(user.profile.id),false);
  } finally {wallet.db.close();}
});

test('statistics deduplicate accounts across lobby and game sockets',async()=>{
  const f=await fixture(false);
  try {
    const ids=f.users.map(u=>u.profile.id);
    f.sockets.set('a',{data:{accountId:ids[0]}}); f.sockets.set('b',{data:{accountId:ids[0]}});
    f.sockets.set('c',{data:{accountId:ids[1]}});
    f.manager.rooms.set('room',{closed:false,started:true,game:{matchOver:()=>false},connectedHumans:()=>[{accountId:ids[1],inLobby:false},{accountId:ids[2],inLobby:false}]});
    const r=await f.management.stats(f.users[0].token);
    assert.equal(r.online,3);assert.equal(r.playing,2);assert.equal(r.activeTables,1);
    assert.equal(r.managerSlots.length,1);
    assert.equal(typeof r.managerSlots[0].playerCode,'string');
  } finally {await f.close();}
});
