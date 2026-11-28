const test=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {PostgresWallet}=require('../src/postgres_wallet');

test('account summary preserves live roles, gift claim and missing player-code recovery',async()=>{
 const db=new PGlite();
 const wallet=new PostgresWallet({query:(sql,args)=>db.query(sql,args),connect:async()=>({query:(sql,args)=>db.query(sql,args),release(){}})});
 wallet.db.exec=sql=>db.exec(sql);
 try{
  await wallet.initialize();
  const user=await wallet.register({email:'account-summary@example.test',name:'Summary',password:'fixture-1234'});
  const id=user.profile.id;
  let result=await wallet.account(user.token);
  assert.equal(result.profile.isManager,false);assert.equal(result.profile.isAdmin,false);
  assert.equal(result.profile.email,'account-summary@example.test');assert.equal(result.profile.carrots,1000);
  await wallet.setAdmin(id,true);
  result=await wallet.account(user.token);assert.equal(result.profile.isAdmin,true);assert.equal(result.profile.isManager,false);
  await wallet.db.run('INSERT INTO managers (slot, account_id) VALUES (1, ?)',id);
  result=await wallet.account(user.token);assert.equal(result.profile.isManager,true);assert.equal(result.profile.isAdmin,true);
  await wallet.db.run('DELETE FROM managers WHERE account_id = ?',id);
  await wallet.setAdmin(id,false);
  await wallet.db.run('DELETE FROM player_codes WHERE account_id = ?',id);
  result=await wallet.account(user.token);assert.match(result.profile.playerCode,/^\d{8}$/);assert.equal(result.profile.isAdmin,false);
  const tomorrow=Date.now()+86400000;
  result=await wallet.account(user.token,tomorrow);assert.equal(result.pendingDaily,1);
  assert.equal(result.profile.carrots,1000);
  await wallet.logout(user.token);assert.equal((await wallet.account(user.token)).ok,false);
 }finally{await db.close();}
});
