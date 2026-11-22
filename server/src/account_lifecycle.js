'use strict';
const {randomBytes,createHash}=require('node:crypto');
const fail=message=>({ok:false,message});
function anonymizeStatements(id) {
  return [
    {sql:'DELETE FROM sessions WHERE account_id = ?',args:[id]},
    {sql:'DELETE FROM admins WHERE account_id = ?',args:[id]},
    {sql:'DELETE FROM managers WHERE account_id = ?',args:[id]},
    {sql:'DELETE FROM password_resets WHERE account_id = ?',args:[id]},
    {sql:'DELETE FROM player_codes WHERE account_id = ?',args:[id]},
    {sql:'DELETE FROM friendships WHERE a = ? OR b = ?',args:[id,id]},
    {sql:'DELETE FROM friend_invites WHERE sender = ? OR receiver = ?',args:[id,id]},
    {sql:"UPDATE accounts SET name = 'Silinen Oyuncu', email = ?, password = ?, salt = ? WHERE id = ?",
      args:['deleted+'+id+'@invalid.local',randomBytes(64).toString('hex'),randomBytes(16).toString('hex'),id]},
  ];
}
class AccountLifecycle {
  constructor(wallet,management) {this.wallet=wallet;this.management=management;this.db=management.db;}
  async remove(token,password,confirmation) {
    const id=await this.wallet.authenticate(token);
    if(!id) return fail('Hesabına giriş yap.');
    if(confirmation!=='SİL') return fail('Silme onayı gerekli.');
    const account=await this.db.get('SELECT email FROM accounts WHERE id = ?',id);
    const verified=await this.wallet.login({email:account?.email,password});
    if(!verified.ok || verified.profile.id!==id) return fail('Şifre doğrulanamadı.');
    // Verification creates an extra session; keep it out of the deletion transaction.
    await this.wallet.logout(verified.token);
    return this.erase(id,token);
  }
  async removeWithCredentials(email,password,confirmation) {
    if(confirmation!=='SİL') return fail('Silme onayı gerekli.');
    const verified=await this.wallet.login({email,password});
    if(!verified.ok) return fail('Hesap doğrulanamadı.');
    try {return await this.erase(verified.profile.id,verified.token);}
    finally {await this.wallet.logout(verified.token);}
  }
  async erase(id,token) {
    const now=Date.now(), hash=createHash('sha256').update(token).digest('hex');
    const auth='SELECT 1 FROM sessions WHERE hash = ? AND account_id = ? AND expires > ?';
    const commands=anonymizeStatements(id);
    commands.unshift({sql:"INSERT INTO account_controls VALUES (?, 'deleted', 'Kullanıcı isteği', ?) ON CONFLICT(account_id) DO UPDATE SET status = excluded.status, reason = excluded.reason, updated = excluded.updated",args:[id,now]});
    const check=(manager,count,session)=>{
      if(!session) throw Error('Oturum geçersiz.');
      if(manager && Number(count.n)<2) throw Error('Hesabını silmeden önce Yönetici Paneli üzerinden ikinci yöneticiyi ata.');
    };
    try {
      if(this.management.sqlite) this.wallet.transaction(()=>{
        const db=this.wallet.db;
        check(db.prepare('SELECT 1 FROM managers WHERE account_id = ?').get(id),db.prepare('SELECT COUNT(*) AS n FROM managers').get(),db.prepare(auth).get(hash,id,now));
        for(const command of commands) db.prepare(command.sql).run(...command.args);
      });
      else await this.wallet.db.transaction(async(db)=>{
        await db.get('SELECT id FROM management_state WHERE id = 1 FOR UPDATE');
        await db.get('SELECT id FROM accounts WHERE id = ? FOR UPDATE',id);
        check(await db.get('SELECT 1 FROM managers WHERE account_id = ?',id),await db.get('SELECT COUNT(*) AS n FROM managers'),await db.get(auth,hash,id,now));
        for(const command of commands) await db.run(command.sql,...command.args);
      });
    } catch(error) {
      if(error.message==='Oturum geçersiz.' || error.message.startsWith('Hesabını silmeden')) return fail(error.message);
      throw error;
    }
    // Deliver the acknowledgement before closing the requester's socket.
    setTimeout(()=>this.management.kick(id,'delete','Kullanıcı isteği'),100).unref();
    return {ok:true,message:'Hesabın silindi.'};
  }
}
module.exports={AccountLifecycle,anonymizeStatements};
