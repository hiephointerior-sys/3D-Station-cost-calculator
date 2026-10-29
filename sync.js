/* Local-first Supabase sync for 3D Print Cost Calculator.
   Local calculations continue to work if Supabase is not configured or offline. */
(() => {
  const $ = id => document.getElementById(id);
  const config = window.SUPABASE_CONFIG || {};
  const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(config.url || '') &&
    typeof config.anonKey === 'string' && config.anonKey.length > 20 && !config.anonKey.includes('YOUR_');
  let client = null, user = null, timer = null, syncing = false, remoteChannel = null, lastRemoteUpdate = null;
  const TABLE = 'user_app_state', BUCKET = 'product-images';
  const status = (message, state='') => { const el=$('syncStatus'); if(el){el.textContent=message;el.dataset.state=state;} };
  const buttons = signed => { ['syncNowBtn','syncPullBtn'].forEach(id=>{if($(id))$(id).disabled=!signed;}); if($('syncSignOutBtn'))$('syncSignOutBtn').hidden=!signed; if($('syncSignInBtn'))$('syncSignInBtn').disabled=!!signed; if($('syncSignUpBtn'))$('syncSignUpBtn').disabled=!!signed; };
  const clone = x => JSON.parse(JSON.stringify(x));
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : 'id-'+Date.now()+'-'+Math.random().toString(16).slice(2);
  function normalize(s){s=clone(s||{});s.materials=Array.isArray(s.materials)?s.materials:[];s.products=Array.isArray(s.products)?s.products:[];s.settings=s.settings||{};s._deleted=s._deleted||{products:[],materials:[]};s._deleted.products=Array.isArray(s._deleted.products)?s._deleted.products:[];s._deleted.materials=Array.isArray(s._deleted.materials)?s._deleted.materials:[];s.materials.forEach((m,i)=>{if(!m.id)m.id='mat-migrated-'+(m.name||i).toString().replace(/[^a-z0-9]/gi,'-')+'-'+i;});s.products.forEach((p,i)=>{if(!p.id)p.id='prod-migrated-'+(p.sku||p.name||i).toString().replace(/[^a-z0-9]/gi,'-')+'-'+i;});return s;}
  function merge(local, remote, prefer='local'){
    local=normalize(local);remote=normalize(remote);
    const deleted={products:[...new Set([...(local._deleted.products||[]),...(remote._deleted.products||[])])],materials:[...new Set([...(local._deleted.materials||[]),...(remote._deleted.materials||[])])]};
    const mergeList=(a,b,kind)=>{const map=new Map();(prefer==='remote'?[...a,...b]:[...b,...a]).forEach(item=>{if(item?.id)map.set(item.id,item);});return [...map.values()].filter(x=>!deleted[kind].includes(x.id));};
    return { ...remote, ...local, materials:mergeList(local.materials,remote.materials,'materials'), products:mergeList(local.products,remote.products,'products'), settings:prefer==='remote'?{...(local.settings||{}),...(remote.settings||{})}:{...(remote.settings||{}),...(local.settings||{})}, _deleted:deleted };
  }
  async function uploadImages(data){
    const copy=clone(data);
    for(const p of copy.products){
      const localProduct=(data.products||[]).find(x=>x.id===p.id);
      const image=localProduct?.image || p.image || '';
      if(image.startsWith('data:image/')){
        const path=`${user.id}/products/${encodeURIComponent(p.id||uid())}.jpg`;
        const response=await fetch(image);const blob=await response.blob();
        const {error}=await client.storage.from(BUCKET).upload(path,blob,{contentType:'image/jpeg',upsert:true,cacheControl:'3600'});
        if(error)throw error;
        p.imageStoragePath=path;p.image='';
      } else if(p.imageStoragePath){p.image='';}
    }
    return copy;
  }
  async function hydrateImages(data){
    const copy=clone(data);
    for(const p of copy.products||[]){
      if(p.imageStoragePath){
        const {data:sd,error}=await client.storage.from(BUCKET).createSignedUrl(p.imageStoragePath,3600);
        if(!error&&sd?.signedUrl){try{const res=await fetch(sd.signedUrl);if(res.ok){const blob=await res.blob();p.image=await new Promise((resolve,reject)=>{const fr=new FileReader();fr.onload=()=>resolve(fr.result);fr.onerror=reject;fr.readAsDataURL(blob);});}}catch(e){console.warn('Không tải được ảnh cloud',e);}}
      }
    }
    return copy;
  }
  async function readRemote(){const {data,error}=await client.from(TABLE).select('data,updated_at').eq('user_id',user.id).maybeSingle();if(error)throw error;return data||null;}
  async function writeRemote(data){
    const withImages=await uploadImages(normalize(data));
    const {data:row,error}=await client.from(TABLE).upsert({user_id:user.id,data:withImages,updated_at:new Date().toISOString()},{onConflict:'user_id'}).select('updated_at').single();
    if(error)throw error;lastRemoteUpdate=row.updated_at;
    return row;
  }
  async function pullRemote({replace=false}={}){
    const row=await readRemote();if(!row){status('Cloud chưa có dữ liệu. Sẽ tải dữ liệu hiện tại trên thiết bị lên khi đồng bộ.','busy');return false;}
    const remote=await hydrateImages(normalize(row.data));
    const local=normalize(window.__appStateBridge.getState());
    const result=replace?remote:merge(local,remote,'remote');
    window.__appStateBridge.saveLocal(result);lastRemoteUpdate=row.updated_at;
    if(!replace)await writeRemote(result);
    status('Đã tải dữ liệu từ cloud lúc '+new Date(row.updated_at).toLocaleString('vi-VN')+'.','ok');
    return true;
  }
  async function syncNow({forcePull=false}={}){
    if(!client||!user){status('Hãy đăng nhập để đồng bộ.','error');return;}
    if(!navigator.onLine){status('Đang ngoại tuyến. Dữ liệu vẫn lưu trên thiết bị; sẽ đồng bộ khi có mạng.','busy');return;}
    if(syncing)return;syncing=true;status('Đang đồng bộ dữ liệu và ảnh…','busy');
    try{
      const row=await readRemote();
      if(forcePull){if(!row){status('Cloud chưa có dữ liệu để tải xuống.','error');return;}await pullRemote({replace:true});return;}
      const local=normalize(window.__appStateBridge.getState());
      if(!row){await writeRemote(local);status('Đã chuyển dữ liệu trên thiết bị này lên cloud lần đầu.','ok');}
      else{
        const remote=await hydrateImages(normalize(row.data));
        const merged=merge(local,remote);window.__appStateBridge.saveLocal(merged);await writeRemote(merged);
        status('Đồng bộ thành công lúc '+new Date().toLocaleString('vi-VN')+'.','ok');
      }
    }catch(e){console.error(e);status('Đồng bộ lỗi: '+(e.message||'Không rõ nguyên nhân')+'. Kiểm tra cấu hình, SQL/RLS, Storage và Internet.','error');}
    finally{syncing=false;}
  }
  function onLocalChange(){if(!user)return;clearTimeout(timer);timer=setTimeout(()=>syncNow(),1200);}
  async function setSession(session){user=session?.user||null;buttons(!!user);if(!user){status('Chưa đăng nhập. Dữ liệu vẫn được lưu cục bộ trên thiết bị.');if(remoteChannel){client.removeChannel(remoteChannel);remoteChannel=null;}return;}
    $('syncEmail').value=user.email||'';status('Đã đăng nhập: '+user.email+'. Đang kiểm tra dữ liệu cloud…','busy');
    try{
      const row=await readRemote();
      if(!row){const local=normalize(window.__appStateBridge.getState());await writeRemote(local);status('Đã tạo bản cloud đầu tiên và chuyển dữ liệu hiện có lên cloud.','ok');}
      else {await pullRemote({replace:false});}
      if(remoteChannel)client.removeChannel(remoteChannel);
      remoteChannel=client.channel('user-app-state-'+user.id).on('postgres_changes',{event:'UPDATE',schema:'public',table:TABLE,filter:'user_id=eq.'+user.id},async payload=>{
        if(syncing)return;const incoming=payload.new;if(!incoming?.data||incoming.updated_at===lastRemoteUpdate)return;
        try{syncing=true;const remote=await hydrateImages(normalize(incoming.data));const merged=merge(normalize(window.__appStateBridge.getState()),remote,'remote');window.__appStateBridge.saveLocal(merged);lastRemoteUpdate=incoming.updated_at;status('Đã nhận cập nhật từ thiết bị khác.','ok');}catch(e){console.warn(e);}finally{syncing=false;}
      }).subscribe();
    }catch(e){console.error(e);status('Đăng nhập được nhưng chưa đồng bộ: '+(e.message||'Kiểm tra SQL/RLS/Storage.'),'error');}
  }
  async function init(){
    if(!configured||!window.supabase?.createClient){buttons(false);status('Chưa cấu hình Supabase. Mở supabase-config.js và điền Project URL + Publishable/anon key.');return;}
    client=window.supabase.createClient(config.url,config.anonKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
    $('syncSignInBtn')?.addEventListener('click',async()=>{const email=$('syncEmail').value.trim(),password=$('syncPassword').value;if(!email||!password){status('Nhập email và mật khẩu trước.','error');return;}status('Đang đăng nhập…','busy');const {data,error}=await client.auth.signInWithPassword({email,password});if(error){status(error.message,'error');return;}await setSession(data.session);});
    $('syncSignUpBtn')?.addEventListener('click',async()=>{const email=$('syncEmail').value.trim(),password=$('syncPassword').value;if(!email||password.length<8){status('Nhập email hợp lệ và mật khẩu ít nhất 8 ký tự.','error');return;}status('Đang tạo tài khoản…','busy');const {data,error}=await client.auth.signUp({email,password});if(error){status(error.message,'error');return;}if(data.session)await setSession(data.session);else status('Đã tạo tài khoản. Hãy xác minh email theo hướng dẫn Supabase, sau đó đăng nhập.','ok');});
    $('syncSignOutBtn')?.addEventListener('click',async()=>{const {error}=await client.auth.signOut();if(error)status(error.message,'error');else await setSession(null);});
    $('syncNowBtn')?.addEventListener('click',()=>syncNow());$('syncPullBtn')?.addEventListener('click',()=>{if(confirm('Tải dữ liệu cloud đè lên dữ liệu cục bộ hiện tại? Những thay đổi chỉ có trên thiết bị này có thể bị thay thế.'))syncNow({forcePull:true});});
    window.addEventListener('online',()=>{if(user)syncNow();});window.addEventListener('offline',()=>{if(user)status('Mất kết nối. Dữ liệu vẫn lưu cục bộ và sẽ thử đồng bộ khi có mạng.','busy');});
    window.cloudSync={onLocalChange};
    const {data,error}=await client.auth.getSession();if(error)status(error.message,'error');else await setSession(data.session);
    client.auth.onAuthStateChange((event,session)=>{if(event==='SIGNED_OUT')setSession(null);else if(event==='SIGNED_IN'&&session?.user?.id!==user?.id)setTimeout(()=>setSession(session),0);});
  }
  window.addEventListener('DOMContentLoaded',init);
})();
