'use strict';

const GAMMA='https://gamma-api.polymarket.com';
const CLOB='https://clob.polymarket.com';
const MARKET_WS='wss://ws-subscriptions-clob.polymarket.com/ws/market';

async function getJson(url){
  const r=await fetch(url,{signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw new Error(`${new URL(url).host} HTTP ${r.status}`);
  return r.json();
}
function parseArray(x){if(Array.isArray(x))return x;if(typeof x==='string'){try{return JSON.parse(x)}catch(_){}}return []}

async function getAssetMarket(asset,windowStart,windowMs){
  const symbol=String(asset).toLowerCase();
  const minutes=windowMs/60000;
  const slug=`${symbol}-updown-${minutes}m-${Math.floor(windowStart/1000)}`;
  const data=await getJson(`${GAMMA}/markets?slug=${encodeURIComponent(slug)}`);
  const market=(Array.isArray(data)?data:data.markets||[])[0];
  if(!market)return null;
  const outcomes=parseArray(market.outcomes), ids=parseArray(market.clobTokenIds||market.outcomeTokenIds);
  const tokens={};
  for(let i=0;i<outcomes.length;i++){
    const label=String(typeof outcomes[i]==='string'?outcomes[i]:outcomes[i].name||outcomes[i].label).toLowerCase();
    if(label==='up'||label==='yes')tokens.UP=ids[i];
    if(label==='down'||label==='no')tokens.DOWN=ids[i];
  }
  if(!tokens.UP||!tokens.DOWN)throw new Error(`${asset} ${minutes}-minute market outcomes could not be mapped to UP/DOWN`);
  return {id:String(market.id||market.conditionId),conditionId:String(market.conditionId||market.id),
    asset:String(asset).toUpperCase(),slug,title:market.question||market.title||slug,
    start:windowStart,end:windowStart+windowMs,tokens,raw:market};
}

async function getBtcMarket(windowStart,windowMs){return getAssetMarket('BTC',windowStart,windowMs)}
async function getEthMarket(windowStart,windowMs){return getAssetMarket('ETH',windowStart,windowMs)}
async function getBook(tokenId){
  return getJson(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`);
}
async function getMarket(id){return getJson(`${GAMMA}/markets/${encodeURIComponent(id)}`)}

function connectMarketStream(tokenIds, options={}) {
  const assets=[...new Set((Array.isArray(tokenIds)?tokenIds:[]).map(String).filter(Boolean))];
  if(!assets.length)throw new Error('At least one Polymarket outcome token is required.');
  const WebSocketImpl=options.WebSocketImpl||globalThis.WebSocket;
  if(typeof WebSocketImpl!=='function')throw new Error('This Node runtime does not provide WebSocket.');
  const onMessage=typeof options.onMessage==='function'?options.onMessage:()=>{};
  const onStatus=typeof options.onStatus==='function'?options.onStatus:()=>{};
  const heartbeatMs=Number(options.heartbeatMs)||10_000;
  const reconnectMinMs=Number(options.reconnectMinMs)||1_000;
  const reconnectMaxMs=Number(options.reconnectMaxMs)||15_000;
  const reconnect=options.reconnect!==false;
  let socket=null,pingTimer=null,reconnectTimer=null,stopped=false,reconnectCount=0;

  function report(status,extra={}) {
    try{onStatus({status,reconnectCount,...extra})}catch(_){}
  }
  function clearPing() {
    if(pingTimer){clearInterval(pingTimer);pingTimer=null}
  }
  function parseMessage(data) {
    if(typeof data==='string')return Promise.resolve(data);
    if(typeof Buffer!=='undefined'&&Buffer.isBuffer(data))return Promise.resolve(data.toString('utf8'));
    if(data&&typeof data.text==='function')return data.text();
    return Promise.resolve(String(data??''));
  }
  function sendHeartbeat() {
    if(stopped||!socket||socket.readyState!==1)return;
    try{socket.send('PING')}
    catch(error){
      report('ERROR',{error:error?.message||'WebSocket heartbeat failed.'});
      try{socket.close()}catch(_){}
    }
  }
  function scheduleReconnect() {
    if(stopped||!reconnect||reconnectTimer)return;
    const delay=Math.min(reconnectMinMs*(2**Math.min(reconnectCount,6)),reconnectMaxMs);
    reconnectCount+=1;
    report('DISCONNECTED',{retryInMs:delay});
    reconnectTimer=setTimeout(()=>{
      reconnectTimer=null;
      connect();
    },delay);
    reconnectTimer.unref?.();
  }
  function connect() {
    if(stopped)return;
    report('CONNECTING');
    try{socket=new WebSocketImpl(MARKET_WS)}
    catch(error){
      report('ERROR',{error:error?.message||'WebSocket connection could not start.'});
      scheduleReconnect();
      return;
    }
    const current=socket;
    current.addEventListener('open',()=>{
      if(stopped||current!==socket)return;
      try{
        current.send(JSON.stringify({
          assets_ids:assets,
          type:'market',
          custom_feature_enabled:true,
        }));
      }catch(error){
        report('ERROR',{error:error?.message||'WebSocket subscription failed.'});
        try{current.close()}catch(_){}
        return;
      }
      reconnectCount=0;
      report('CONNECTED');
      clearPing();
      pingTimer=setInterval(sendHeartbeat,heartbeatMs);
      pingTimer.unref?.();
    });
    current.addEventListener('message',event=>{
      if(stopped||current!==socket)return;
      void parseMessage(event?.data).then(text=>{
        if(text==='PONG'||text==='PING'||!text)return;
        let parsed;
        try{parsed=JSON.parse(text)}
        catch(error){
          report('ERROR',{error:'Received an unreadable market WebSocket message.'});
          return;
        }
        const messages=Array.isArray(parsed)?parsed:[parsed];
        for(const message of messages){
          if(message&&typeof message==='object'){
            try{onMessage(message)}catch(onError){
              report('ERROR',{error:onError?.message||'Market update handler failed.'});
            }
          }
        }
      }).catch(error=>report('ERROR',{error:error?.message||'Market WebSocket message failed.'}));
    });
    current.addEventListener('error',()=>{
      if(!stopped&&current===socket)report('ERROR',{error:'Polymarket market WebSocket reported an error.'});
    });
    current.addEventListener('close',event=>{
      if(current!==socket)return;
      clearPing();
      if(stopped)return;
      scheduleReconnect();
      if(event?.code)report('DISCONNECTED',{closeCode:event.code});
    });
  }

  connect();
  return {
    close(){
      if(stopped)return;
      stopped=true;
      clearPing();
      if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null}
      const current=socket;
      socket=null;
      try{current?.close()}catch(_){}
      report('DISCONNECTED');
    },
  };
}

module.exports={getAssetMarket,getBtcMarket,getEthMarket,getBook,getMarket,connectMarketStream};
