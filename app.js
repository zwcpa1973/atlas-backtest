const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const safeText=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const toast=t=>{const e=$('#toast');e.textContent=t;e.classList.add('show');setTimeout(()=>e.classList.remove('show'),1800)};
let currentResult=null;
let chartMonths=0,chartOffset=100,history=[],historyIndex=-1,restoring=false,treeDepthLimit=99,treeZoom=1,chartTipPinned=false,currentStrategyId=localStorage.getItem('atlas-current-strategy-id')||null,libraryRows=[],tickerMatches=[],tickerMatchIndex=-1,tickerMatchQuery='',selectedTickerPath=null;
const strategy={nodes:[{type:'group',title:'核心动量组合',meta:'风险平价 · 60%',children:[{type:'asset',title:'QQQ · 纳斯达克100',meta:'30%'},{type:'asset',title:'SPY · 标普500',meta:'20%'},{type:'asset',title:'QLD · 两倍纳指',meta:'10%'}]},{type:'branch',title:'风险开关：SPY 价格 > 200日均线',meta:'IF / ELSE',children:[{type:'asset',title:'趋势开启 → TQQQ',meta:'25%'},{type:'asset',title:'趋势关闭 → BIL',meta:'15%'}]},{type:'group',title:'防御资产篮子',meta:'波动率倒数 · 40%',children:[{type:'asset',title:'GLD · 黄金',meta:'15%'},{type:'asset',title:'TLT · 长期国债',meta:'15%'},{type:'asset',title:'BIL · 短期国债',meta:'10%'}]}]};
const allowedTypes=new Set(['group','branch','asset']);
function normalizeNode(node,index=0){
  if(typeof node==='string') return {type:'asset',title:node,meta:'0%'};
  if(!node||typeof node!=='object') return null;
  const rawChildren=node.children||node.nodes||node.items||node.assets;
  const children=Array.isArray(rawChildren)?rawChildren.map((n,i)=>normalizeNode(n,i)).filter(Boolean):undefined;
  let type=allowedTypes.has(node.type)?node.type:(children?.length?'group':'asset');
  if(/if|condition|branch/i.test(node.type||node.kind||'')) type='branch';
  const ticker=node.ticker||node.symbol;
  const title=node.title||node.name||node.label||(ticker?`${ticker} · 美股资产`:`导入节点 ${index+1}`);
  const meta=node.meta||node.weight||node.allocation||(type==='branch'?'IF / ELSE':children?.length?`${children.length} 个子节点`:'0%');
  return {type,title:String(title),meta:String(meta),...(children?.length?{children}:{})};
}
function indicatorLabel(symbol,spec={},daysAgo=0){
  const kind=spec.type||'CurrentPrice',window=Number(spec.window||0);
  const names={CurrentPrice:'当前价格',MovingAverage:'均线（SMA）',ExponentialMovingAverage:'指数均线（EMA）',RelativeStrengthIndex:'RSI',CumulativeReturn:'累计收益率',MovingAverageOfReturns:'平均收益率',MaxDrawdown:'最大回撤',StandardDeviation:'标准差'};
  const period=kind!=='CurrentPrice'&&window>0?`${window}日`:'';
  return `${symbol||'未知标的'} ${period}${names[kind]||kind}${Number(daysAgo)>0?`（${daysAgo}日前）`:''}`;
}
function conditionTitle(node){
  const c=node.condition||{};
  const lhs=indicatorLabel(c.lh_ticker_symbol,c.lh_indicator,c.lh_days_ago);
  let rhs=c.type==='IndicatorAndNumber'?String(c.rh_value??c.rh_value_int??0):indicatorLabel(c.rh_ticker_symbol,c.rh_indicator,c.rh_days_ago);
  const weight=Number(c.rh_weight??1),bias=Number(c.rh_bias??0);
  if(weight!==1)rhs=`(${rhs}) × ${weight}`;
  if(bias!==0)rhs+=bias>0?` + ${bias}`:` − ${Math.abs(bias)}`;
  return `${node.name||'条件'}：${lhs} ${c.greater_than?'＞':'＜'} ${rhs}`;
}
function refreshConditionLabels(){
  const root=strategy.definition?.incantation||strategy.definition;
  if(!root?.incantation_type||strategy.nodes.length!==1)return;
  const walk=(raw,visual)=>{
    if(!raw||!visual)return;
    if(raw.incantation_type==='IfElse'&&visual.type==='branch')visual.title=conditionTitle(raw);
    const children=raw.incantation_type==='IfElse'?[raw.then_incantation,raw.else_incantation]:(raw.incantations||[]);
    children.forEach((child,index)=>walk(child,visual.children?.[index]));
  };
  walk(root,strategy.nodes[0]);
}
function composerToNode(node,index=0){
  if(!node||typeof node!=='object')return null;
  const kind=node.incantation_type;
  if(kind==='Ticker')return {type:'asset',title:`${node.symbol} · 美股资产`,meta:'动态权重'};
  if(kind==='IfElse'){
    const c=node.condition||{};
    return {type:'branch',title:conditionTitle(node),meta:`IF / ELSE · 连续${c.for_days||1}日`,children:[composerToNode(node.then_incantation,0),composerToNode(node.else_incantation,1)].filter(Boolean)};
  }
  const children=(node.incantations||[]).map(composerToNode).filter(Boolean);
  if(kind==='Weighted')return {type:'group',title:node.name||'加权组合',meta:`${node.type||'Equal'} · ${children.length}项`,children};
  if(kind==='Filter'||kind==='Filtered')return {type:'group',title:node.name||'动量筛选',meta:`${node.bottom?'Bottom':'Top'} ${node.count||node.select_n||1} · ${node.sort_indicator?.type||'指标'}`,children};
  return normalizeNode(node,index);
}
function extractImportedNodes(data){
  if(data?.incantation)return [composerToNode(data.incantation)].filter(Boolean);
  if(data?.incantation_type)return [composerToNode(data)].filter(Boolean);
  const candidates=[data?.strategy?.nodes,data?.nodes,data?.strategy?.children,data?.children,data?.portfolio?.nodes];
  const list=candidates.find(Array.isArray);
  if(list) return list.map((n,i)=>normalizeNode(n,i)).filter(Boolean);
  const root=data?.strategy?.root||data?.root;
  const normalized=normalizeNode(root);
  return normalized?[normalized]:[];
}
const clone=v=>JSON.parse(JSON.stringify(v));
function nodeAt(path){let list=strategy.nodes,node;for(const part of path.split('-').map(Number)){node=list[part];list=node.children||[]}return node}
function listAt(path){const parts=path.split('-').map(Number),index=parts.pop();let list=strategy.nodes;for(const p of parts)list=list[p].children;return {list,index}}
function snapshot(){if(restoring)return;history=history.slice(0,historyIndex+1);history.push(clone(strategy));historyIndex=history.length-1;if(history.length>50){history.shift();historyIndex--}updateUndo()}
function updateUndo(){const unavailable=historyIndex<=0;$('#undoBtn').disabled=unavailable;$('#redoBtn').disabled=historyIndex>=history.length-1;const tickerUndo=$('#tickerUndoBtn');if(tickerUndo)tickerUndo.disabled=unavailable}
function restore(index){if(index<0||index>=history.length)return;restoring=true;const s=clone(history[index]);strategy.nodes.splice(0,strategy.nodes.length,...s.nodes);if(s.definition)strategy.definition=s.definition;else delete strategy.definition;historyIndex=index;renderTree();restoring=false;updateUndo()}
function countNodes(nodes){return (nodes||[]).reduce((sum,n)=>sum+1+countNodes(n.children),0)}
function nodeTone(n){const text=`${n.title||''} ${n.meta||''}`.toLowerCase();if(n.type!=='group')return '';if(/inverse|逆波动/.test(text))return 'inverse-group';if(/filter|top |bottom |筛选/.test(text))return 'filter-group';if(/custom|自定义/.test(text))return 'custom-group';if(/equal|等权/.test(text))return 'equal-group';return 'standard-group'}
function renderTree(){
  refreshConditionLabels();
  const make=(n,path,relation='',depth=0)=>`<div class="node ${n.type} ${nodeTone(n)} ${relation==='否则'?'else-leg':relation?'then-leg':''}" data-path="${path}">${relation?`<div class="edge-label ${relation==='否则'?'else':''}">${relation==='否则'?'否则 / ELSE':'满足条件 / THEN'}</div>`:''}<div class="node-row"><button class="toggle" title="展开或收起">${n.children?.length?'⌄':'•'}</button><span class="node-icon">${n.type==='branch'?'⑂':n.type==='asset'?'●':'◔'}</span><span class="node-tag">${n.type==='branch'?'条件':n.type==='asset'?'资产':'组合'}</span><span class="node-title" contenteditable="true">${n.title}</span><span class="node-meta" contenteditable="true">${n.meta}</span><span class="node-actions"><button class="duplicate" title="复制">⧉</button><button class="delete" title="删除">×</button></span></div>${n.children?(depth>=treeDepthLimit?`<div class="lazy-children"><button class="load-more-tree">＋ 展开更深层级 · ${countNodes(n.children)} 个节点</button></div>`:`<div class="children">${n.children.map((c,j)=>make(c,`${path}-${j}`,n.type==='branch'?(j===0?'满足条件':'否则'):'',depth+1)).join('')}</div>`):''}</div>`;
  $('#tree').innerHTML=strategy.nodes.map((n,i)=>make(n,String(i))).join('')||'<div style="padding:20px;color:#718096">暂无节点，请添加或导入策略。</div>';
  $$('.toggle').forEach(b=>b.onclick=()=>{b.closest('.node').querySelector(':scope > .children')?.classList.toggle('collapsed');requestAnimationFrame(updateTreeScrollSize)});
  $$('.delete').forEach(b=>b.onclick=()=>{const {list,index}=listAt(b.closest('.node').dataset.path);list.splice(index,1);delete strategy.definition;snapshot();renderTree();toast('节点已移除')});
  $$('.duplicate').forEach(b=>b.onclick=()=>{const {list,index}=listAt(b.closest('.node').dataset.path);list.splice(index+1,0,clone(list[index]));delete strategy.definition;snapshot();renderTree();toast('节点已复制')});
  $$('.node-title,.node-meta').forEach(e=>e.onblur=()=>{const n=nodeAt(e.closest('.node').dataset.path),key=e.classList.contains('node-title')?'title':'meta';if(n[key]!==e.textContent.trim()){n[key]=e.textContent.trim();delete strategy.definition;snapshot();toast('节点已更新')}})
  $$('.load-more-tree').forEach(b=>b.onclick=()=>{treeDepthLimit+=2;renderTree();toast(`当前显示至第 ${treeDepthLimit+1} 层`)});
  enhanceBuilderNodes();
  requestAnimationFrame(updateTreeScrollSize);
}
function updateTreeScrollSize(){const viewport=$('#treeViewport'),inner=$('#treeTopScrollInner'),top=$('#treeTopScroll');if(!viewport||!inner)return;inner.style.width=`${viewport.scrollWidth}px`;top.scrollLeft=viewport.scrollLeft}
function setTreeZoom(value){treeZoom=Math.max(.5,Math.min(1.6,Math.round(value*10)/10));$('#treeCanvas').style.zoom=treeZoom;$('#zoomValue').value=`${Math.round(treeZoom*100)}%`;requestAnimationFrame(updateTreeScrollSize)}
function fitTreeWidth(){const canvas=$('#treeCanvas'),viewport=$('#treeViewport');canvas.style.zoom=1;const natural=Math.max(canvas.scrollWidth,1);setTreeZoom(Math.max(.5,Math.min(1,viewport.clientWidth/natural)))}
function bindTreeViewport(){const viewport=$('#treeViewport'),top=$('#treeTopScroll');let syncing=false;viewport.addEventListener('scroll',()=>{if(syncing)return;syncing=true;top.scrollLeft=viewport.scrollLeft;syncing=false});top.addEventListener('scroll',()=>{if(syncing)return;syncing=true;viewport.scrollLeft=top.scrollLeft;syncing=false});viewport.addEventListener('wheel',event=>{if(!event.ctrlKey)return;event.preventDefault();setTreeZoom(treeZoom+(event.deltaY<0?.1:-.1))},{passive:false});$('#zoomOut').onclick=()=>setTreeZoom(treeZoom-.1);$('#zoomIn').onclick=()=>setTreeZoom(treeZoom+.1);$('#zoomReset').onclick=()=>setTreeZoom(1);$('#zoomFit').onclick=fitTreeWidth;setTreeZoom(1)}
const metrics=[['累计收益','+286.4%','good'],['年化收益','19.2%','good'],['最大回撤','-18.7%',''],['夏普比率','1.42',''],['索提诺比率','2.11',''],['胜率','58.6%',''],['波动率','14.8%','']];
function renderMetrics(){ $('#metrics').innerHTML=metrics.map(x=>`<div class="metric"><div class="label">${x[0]}</div><div class="value ${x[2]}">${x[1]}</div></div>`).join('') }
const years=[['2019','+17.4%','+16.2%','+1.2%','-7.4%','57.1%'],['2020','+39.8%','+18.4%','+21.4%','-16.9%','62.5%'],['2021','+27.1%','+28.7%','-1.6%','-8.2%','59.3%'],['2022','-11.6%','-18.2%','+6.6%','-18.7%','48.0%'],['2023','+31.5%','+26.3%','+5.2%','-9.1%','61.5%'],['2024','+24.8%','+23.3%','+1.5%','-8.6%','60.2%'],['2025','+20.3%','+16.9%','+3.4%','-10.4%','58.7%']];
function tables(){ $('#statsBody').innerHTML=years.map(r=>`<tr>${r.map((v,i)=>`<td class="${v[0]==='+'?'positive':''}">${v}</td>`).join('')}</tr>`).join('');const alloc=[['QQQ','28.5'],['SPY','20.0'],['GLD','15.0'],['TLT','14.2'],['BIL','12.3'],['IWM','10.0']];$('#allocGrid').innerHTML=alloc.map(a=>`<div class="alloc-card"><span>${a[0]}</span><b>${a[1]}%</b><div class="bar"><i style="width:${a[1]*3}%"></i></div></div>`).join('')}
function visibleRange(){if(!currentResult)return {from:0,to:0};const total=currentResult.dates.length;if(!chartMonths)return {from:0,to:total};const approx=Math.max(2,Math.round(chartMonths*21));const room=Math.max(0,total-approx),from=Math.round(room*chartOffset/100);return {from,to:Math.min(total,from+approx)}}
function drawNavigator(){if(!currentResult)return;const c=$('#navChart'),ctx=c.getContext('2d'),dpr=devicePixelRatio||1,w=c.clientWidth,h=c.clientHeight;c.width=w*dpr;c.height=h*dpr;ctx.scale(dpr,dpr);ctx.clearRect(0,0,w,h);const pts=currentResult.equity,min=Math.min(...pts),max=Math.max(...pts);ctx.strokeStyle='#4d8dff';ctx.lineWidth=1;ctx.beginPath();pts.forEach((p,i)=>{const x=i/(pts.length-1)*w,y=h-((p-min)/(max-min||1))*h*.8-h*.1;i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.stroke();const {from,to}=visibleRange();if(chartMonths){ctx.fillStyle='#4d8dff22';ctx.fillRect(from/(pts.length-1)*w,0,(to-from)/(pts.length-1)*w,h)}$('#viewStart').textContent=currentResult.dates[from]||'完整区间';$('#viewEnd').textContent=currentResult.dates[Math.max(from,to-1)]||'最新'}
function chart(seed=1){const c=$('#chart'),ctx=c.getContext('2d'),dpr=devicePixelRatio||1,w=c.clientWidth,h=c.clientHeight;c.width=w*dpr;c.height=h*dpr;ctx.scale(dpr,dpr);ctx.clearRect(0,0,w,h);ctx.strokeStyle='#222d3a';ctx.lineWidth=1;for(let i=1;i<6;i++){let y=i*h/6;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke()}for(let i=1;i<10;i++){let x=i*w/10;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke()}let rng=seed;const rand=()=>((rng=Math.sin(rng)*10000)-Math.floor(rng));let series,dates;if(currentResult){const {from,to}=visibleRange(),benchmark=currentResult.benchmarkEquity.slice(from,to),portfolio=currentResult.equity.slice(from,to),qqq=currentResult.qqqEquity.slice(from,to),benchmarkBase=benchmark[0]||1,portfolioBase=portfolio[0]||1,qqqBase=qqq[0]||1;series=[benchmark.map(v=>v/benchmarkBase*100),portfolio.map(v=>v/portfolioBase*100),qqq.map(v=>v/qqqBase*100)];dates=currentResult.dates.slice(from,to)}else{const fake=(growth,vol)=>{let v=100,pts=[];for(let i=0;i<210;i++){v*=1+growth+(rand()-.48)*vol;pts.push(v)}return pts};series=[fake(.0034,.018),fake(.0062,.021),fake(.0055,.024)];dates=['2019','2020','2021','2022','2023','2024','2025','2026']}const log=$('#logScale')?.checked,transform=v=>log?Math.log(Math.max(v,.001)):v,all=series.flat().map(transform),min=Math.min(...all)*.96,max=Math.max(...all)*1.04;const colors=['#53cf91','#4d8dff','#f59e0b'];series.forEach((pts,si)=>{ctx.strokeStyle=colors[si]||'#888';ctx.lineWidth=1.7;ctx.beginPath();pts.forEach((p,i)=>{let x=i/(pts.length-1)*w,y=h-((transform(p)-min)/(max-min||1))*h*.9-15;i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.stroke()});ctx.fillStyle='#687789';ctx.font='11px JetBrains Mono';for(let i=0;i<8;i++){let idx=Math.floor(i*(dates.length-1)/7),label=dates[idx];if(currentResult)label=label?.slice(0,7);if(label)ctx.fillText(label,i*w/7,h-5)}drawNavigator()}
function showChartTip(event,pin=false){
  if(!currentResult?.dates?.length)return;
  const canvas=$('#chart'),card=canvas.closest('.chart-card'),tip=$('#chartTip'),rect=canvas.getBoundingClientRect();
  const x=Math.max(0,Math.min(rect.width,event.clientX-rect.left)),{from,to}=visibleRange(),count=Math.max(1,to-from);
  const local=Math.round((x/Math.max(rect.width,1))*(count-1)),index=Math.min(currentResult.dates.length-1,from+local);
  const baseStrategy=currentResult.equity[from]||1,baseBenchmark=currentResult.benchmarkEquity[from]||1,baseQqq=currentResult.qqqEquity[from]||1;
  const strategyValue=currentResult.equity[index],benchmarkValue=currentResult.benchmarkEquity[index],qqqValue=currentResult.qqqEquity[index];
  const prevStrategy=index>from?currentResult.equity[index-1]:strategyValue,prevBenchmark=index>from?currentResult.benchmarkEquity[index-1]:benchmarkValue,prevQqq=index>from?currentResult.qqqEquity[index-1]:qqqValue;
  tip.innerHTML=`<b>${currentResult.dates[index]}</b><div class="tip-base">区间起点 ${currentResult.dates[from]} = 100</div><div class="tip-row strategy"><span>● 策略区间</span><strong>${pct(strategyValue/baseStrategy-1,2)}</strong></div><div class="tip-sub">当日 ${pct(strategyValue/prevStrategy-1,2)}</div><div class="tip-row benchmark"><span>● 基准区间</span><strong>${pct(benchmarkValue/baseBenchmark-1,2)}</strong></div><div class="tip-sub">当日 ${pct(benchmarkValue/prevBenchmark-1,2)}</div><div class="tip-row" style="color:#f59e0b"><span>● QQQ 区间</span><strong>${pct(qqqValue/baseQqq-1,2)}</strong></div><div class="tip-sub" style="color:#f59e0b">当日 ${pct(qqqValue/prevQqq-1,2)}</div>${pin?'<small>已固定 · 双击图表取消</small>':''}`;
  tip.style.display='block';tip.style.top='12px';
  tip.style.left=`${Math.max(8,Math.min(card.clientWidth-tip.offsetWidth-8,x+18))}px`;
  if(pin)chartTipPinned=true;
}
function bindChartTip(){
  const canvas=$('#chart'),tip=$('#chartTip');
  canvas.addEventListener('mousemove',event=>{if(!chartTipPinned)showChartTip(event)});
  canvas.addEventListener('click',event=>showChartTip(event,true));
  canvas.addEventListener('mouseleave',()=>{if(!chartTipPinned)tip.style.display='none'});
  canvas.addEventListener('dblclick',()=>{chartTipPinned=false;tip.style.display='none'});
}
function pct(v,d=1){return `${v>=0?'+':''}${(v*100).toFixed(d)}%`}
function renderResultSummaries(r){
  const windows=[['1月',21],['3月',63],['半年',126],['1年',252],['2年',504],['3年',756],['5年',1260]];
  const tail=windows.map(([label,n])=>{const a=r.equity[Math.max(0,r.equity.length-1-n)],b=r.equity.at(-1);return [label,a?b/a-1:null]});
  $('#trailingReturns').innerHTML=tail.map(([label,value])=>`<div class="mini-stat"><span>${label}</span><b>${value==null?'—':pct(value)}</b></div>`).join('');
  const first=r.dates[0]||'—',last=r.dates.at(-1)||'—';
  $('#tradingDayStats').innerHTML=`<div class="mini-stat"><span>总交易日</span><b>${r.tradingDays}</b></div><div class="mini-stat"><span>开始</span><b>${first}</b></div><div class="mini-stat"><span>结束</span><b>${last}</b></div>`;
}
function renderAllocationHistory(historyRows){
  const rows=historyRows||[],symbols=[...new Set(rows.flatMap(r=>Object.keys(r.weights||{})))].sort();
  if(!rows.length){$('#allocationHistoryTable').innerHTML='<tbody><tr><td>暂无逐期持仓数据</td></tr></tbody>';requestAnimationFrame(updateAllocationScrollSize);return}
  $('#allocationHistoryTable').innerHTML=`<thead><tr><th>日期</th>${symbols.map(s=>`<th>${s}</th>`).join('')}</tr></thead><tbody>${rows.slice().reverse().map(r=>`<tr><td>${r.date}</td>${symbols.map(s=>{const w=r.weights?.[s]||0;return `<td class="${w?'active-weight':''}">${w?(w*100).toFixed(1)+'%':'—'}</td>`}).join('')}</tr>`).join('')}</tbody>`;
  requestAnimationFrame(updateAllocationScrollSize);
}
function updateAllocationScrollSize(){const range=$('#allocationScrollRange'),view=$('#allocationHistoryViewport'),table=$('#allocationHistoryTable');if(!range||!view||!table)return;const max=Math.max(0,table.scrollWidth-view.clientWidth);range.max=String(max);range.value=String(Math.min(max,view.scrollLeft));range.disabled=max===0}
function bindAllocationScroll(){const top=$('#allocationTopScroll'),range=$('#allocationScrollRange'),view=$('#allocationHistoryViewport');if(!top||!range||!view||top.dataset.bound)return;top.dataset.bound='1';range.addEventListener('input',()=>view.scrollLeft=Number(range.value));view.addEventListener('scroll',()=>range.value=String(view.scrollLeft));window.addEventListener('resize',updateAllocationScrollSize);updateAllocationScrollSize()}
function renderResult(r){
  currentResult=r;
  try{localStorage.setItem('atlas-last-result',JSON.stringify(r))}catch(e){console.warn('回测结果无法本地缓存',e)}
  const m=r.metrics;
  metrics.splice(0,metrics.length,['累计收益',pct(m.cumulative),'good'],['年化收益',pct(m.cagr),'good'],['最大回撤',pct(m.maxDrawdown),''],['夏普比率',m.sharpe.toFixed(2),''],['索提诺比率',m.sortino.toFixed(2),''],['胜率',pct(m.winRate),''],['波动率',pct(m.volatility),'']);
  renderMetrics();renderResultSummaries(r);chart();
  $('#statsBody').innerHTML=r.annual.map(x=>`<tr><td>${x.year}</td><td class="${x.strategy>=0?'positive':''}">${pct(x.strategy)}</td><td>${pct(x.benchmark)}</td><td class="${x.excess>=0?'positive':''}">${pct(x.excess)}</td><td>${Number.isFinite(x.maxDrawdown)?pct(x.maxDrawdown):'—'}</td><td>${Number.isFinite(x.winRate)?pct(x.winRate):'—'}</td></tr>`).join('');
  $('#allocGrid').innerHTML=r.allocations.map(a=>`<div class="alloc-card"><span>${a.symbol}</span><b>${(a.weight*100).toFixed(1)}%</b><div class="bar"><i style="width:${Math.min(a.weight*300,100)}%"></i></div></div>`).join('');
  $('#allocationAsOf').textContent=`最新调仓组合 · ${r.allocationDate||r.dates.at(-1)||'—'}`;
  renderAllocationHistory(r.allocationHistory);
}
$('#tabs').onclick=e=>{if(!e.target.dataset.tab)return;$$('#tabs button').forEach(b=>b.classList.remove('active'));e.target.classList.add('active');$$('.tab-pane').forEach(p=>p.classList.remove('active'));$('#'+e.target.dataset.tab).classList.add('active');if(e.target.dataset.tab==='return')chart(1)};
$('#runBtn').onclick=async()=>{const b=$('#runBtn'),notice=$('#backtestNotice'),start=$('#startDate').value,end=$('#endDate').value;if(!start||!end){notice.textContent='请选择完整的开始和结束日期';notice.className='backtest-notice error';return}if(new Date(start)>=new Date(end)){notice.textContent='开始日期必须早于结束日期';notice.className='backtest-notice error';return}const large=countNodes(strategy.nodes)>300,timeoutMs=large?240000:45000;b.innerHTML='⟳ 正在读取历史库...';b.disabled=true;notice.textContent=large?'大型策略正在准备，预计需要1–4分钟':'正在检查策略代码和本地数据覆盖范围';notice.className='backtest-notice';const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs),phase=setTimeout(()=>{b.innerHTML='⟳ 正在执行策略回测...';notice.textContent=large?'正在逐日解释大型策略节点，请保持页面打开':'正在补充缺失行情或计算策略'},1200);try{const settings={capital:Number($('#capital').value)||100000,frequency:$('#frequency').value,slippage:Number($('#slippage').value)||0,benchmark:$('#benchmark').value,start,end,reinvestDividends:$('#dividends').checked};const res=await fetch('/api/backtest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({strategy,settings}),signal:controller.signal});const data=await res.json();if(!res.ok)throw new Error(data.detail||'回测失败');renderResult(data);notice.textContent=`完成 · ${data.tradingDays}个交易日 · ${data.source}`;notice.className='backtest-notice ok';toast('真实回测完成')}catch(e){const message=e.name==='AbortError'?`回测超过${timeoutMs/1000}秒，请缩短区间或检查数据源`:e.message;notice.textContent=message;notice.className='backtest-notice error';toast('回测未完成，请查看按钮左侧提示');console.error(e)}finally{clearTimeout(timer);clearTimeout(phase);b.innerHTML='<b>▶</b> 运行回测';b.disabled=false}};
function currentSettings(){return {capital:$('#capital').value,frequency:$('#frequency').value,slippage:$('#slippage').value,benchmark:$('#benchmark').value,start:$('#startDate').value,end:$('#endDate').value,reinvestDividends:$('#dividends').checked}}
$('#saveBtn').onclick=()=>saveCurrentStrategy();
$('#saveAsBtn').onclick=()=>saveCurrentStrategy(true);
$('#newBtn').onclick=()=>createBlankStrategy(true);
$('#exportBtn').onclick=()=>{const blob=new Blob([JSON.stringify({name:$('#strategyName').value,settings:currentSettings(),strategy},null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='atlas-strategy.json';a.click();URL.revokeObjectURL(a.href);toast('策略、参数和原始定义已导出')};
$('#exportAllocationBtn').onclick=async()=>{if(!currentResult?.allocationHistory?.length){toast('请先运行回测，再导出持仓权重');return}const button=$('#exportAllocationBtn'),old=button.textContent;button.disabled=true;button.textContent='正在生成…';try{const response=await fetch('/api/export-allocations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({strategyName:$('#strategyName').value,allocationHistory:currentResult.allocationHistory})});if(!response.ok){const error=await response.json().catch(()=>({}));throw Error(error.detail||'导出失败')}const blob=await response.blob(),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`${($('#strategyName').value||'策略').replace(/[\\/:*?"<>|]/g,'_')}-每日调仓权重.xlsx`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);toast('每日调仓权重 Excel 已导出')}catch(error){toast(error.message||'导出失败')}finally{button.disabled=false;button.textContent=old}};
$('#importInput').onchange=async e=>{
  const file=e.target.files?.[0]; if(!file)return;
  try{
    const d=JSON.parse(await file.text());
    const nodes=extractImportedNodes(d);
    if(!nodes.length) throw new Error('没有找到可识别的策略节点');
    currentStrategyId=null;localStorage.removeItem('atlas-current-strategy-id');
    strategy.nodes.splice(0,strategy.nodes.length,...nodes);
    treeDepthLimit=countNodes(nodes)>300?3:99;
    strategy.definition=d.incantation||((d.incantation_type||d.step)?d:(d.strategy?.definition||null));
    $('#strategyName').value=d.name||d.strategy?.name||'导入策略';
    const settings={...(d.settings||d.strategy?.settings||{})};
    // QuantMage exports keep execution settings at the document root rather
    // than under `settings`.  Import them so the same strategy cannot silently
    // run with Atlas defaults (monthly / 8 bps).
    if(d.slippage_bps!=null) settings.slippage=d.slippage_bps;
    if(d.benchmark_ticker) settings.benchmark=d.benchmark_ticker;
    if(d.trading_type){
      const trading=String(d.trading_type).toLowerCase();
      settings.frequency=trading==='daily'?'每日':trading==='quarterly'?'每季度':trading==='monthly'?'每月':settings.frequency;
    }
    if(settings.capital!=null) $('#capital').value=settings.capital;
    if(settings.benchmark&&[...$('#benchmark').options].some(o=>o.value===settings.benchmark)) $('#benchmark').value=settings.benchmark;
    if(settings.slippage!=null) $('#slippage').value=settings.slippage;
    if(settings.frequency&&[...$('#frequency').options].some(o=>o.value===settings.frequency)) $('#frequency').value=settings.frequency;
    renderTree();
    localStorage.setItem('atlas-strategy',JSON.stringify({name:$('#strategyName').value,settings,strategy}));
    toast(`策略导入成功 · ${settings.frequency||$('#frequency').value} · ${settings.slippage??$('#slippage').value} bps`);
  }catch(error){
    console.error('Import failed:',error);
    toast(error.message==='没有找到可识别的策略节点'?error.message:'文件格式无效，导入失败');
  }finally{e.target.value=''}
};
$('#collapseBtn').onclick=()=>{const items=$$('.children'),expand=items.length&&items.every(e=>e.classList.contains('collapsed'));items.forEach(e=>e.classList.toggle('collapsed',!expand));$('#collapseBtn').textContent=expand?'全部收起':'全部展开';toast(expand?'策略树已展开':'策略树已收起')};
$('#addRoot').onclick=()=>{const ticker=(prompt('输入美股代码，例如 AAPL：','AAPL')||'').trim().toUpperCase();if(!ticker)return;strategy.nodes.push({type:'asset',title:`${ticker} · 美股资产`,meta:'0%'});delete strategy.definition;snapshot();renderTree();toast(`已添加 ${ticker}`)};
$('#undoBtn').onclick=()=>restore(historyIndex-1);$('#redoBtn').onclick=()=>restore(historyIndex+1);
function highlightNodeSearch(value,scroll=false){const q=value.trim().toLowerCase();let first=null,count=0;$$('#tree .node').forEach(n=>{const own=n.querySelector(':scope > .node-row').innerText.toLowerCase(),hit=!!q&&own.includes(q);n.classList.toggle('search-hit',hit);n.classList.toggle('search-dim',!!q&&!hit);if(hit){count++;first||=n;let p=n.parentElement.closest('.node');while(p){p.querySelector(':scope > .children')?.classList.remove('collapsed');p.classList.remove('search-dim');p=p.parentElement.closest('.node')}}});if(scroll&&first)first.scrollIntoView({behavior:'smooth',block:'center',inline:'center'});return count}
$('#nodeSearch').oninput=e=>highlightNodeSearch(e.target.value);
const validTicker=value=>/^[A-Z][A-Z0-9.-]{0,11}$/.test(value);
const escapeRegex=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const tickerRegex=value=>new RegExp(`(?<![A-Z0-9.-])${escapeRegex(value)}(?![A-Z0-9.-])`,'gi');
function replaceTickerDeep(value,pattern,replacement,counter){if(typeof value==='string')return value.replace(pattern,()=>{counter.count++;return replacement});if(Array.isArray(value))return value.map(item=>replaceTickerDeep(item,pattern,replacement,counter));if(value&&typeof value==='object'){for(const key of Object.keys(value))value[key]=replaceTickerDeep(value[key],pattern,replacement,counter)}return value}
function tickerNodePaths(ticker){const result=[],walk=(nodes,prefix='')=>(nodes||[]).forEach((node,index)=>{const path=prefix?`${prefix}-${index}`:`${index}`;if(tickerRegex(ticker).test(`${node.title||''} ${node.meta||''}`))result.push(path);walk(node.children,path)});walk(strategy.nodes);return result}
function selectTickerNode(path,ticker){selectedTickerPath=path;$$('#tree .node').forEach(node=>{const selected=node.dataset.path===path,matched=tickerRegex(ticker).test(node.querySelector(':scope > .node-row').innerText);node.classList.toggle('ticker-match',matched&&!selected);node.classList.toggle('ticker-selected',selected);node.classList.toggle('search-hit',false);node.classList.toggle('search-dim',false)});const selected=$(`#tree .node[data-path="${path}"]`);if(selected){let parent=selected.parentElement.closest('.node');while(parent){parent.querySelector(':scope > .children')?.classList.remove('collapsed');parent=parent.parentElement.closest('.node')}selected.scrollIntoView({behavior:'smooth',block:'center',inline:'center'})}}
function findTicker(){const ticker=$('#tickerFind').value.trim().toUpperCase(),status=$('#tickerReplaceStatus');$('#tickerFind').value=ticker;if(!validTicker(ticker)){status.textContent='代码无效';return 0}if(ticker!==tickerMatchQuery){tickerMatchQuery=ticker;tickerMatches=tickerNodePaths(ticker);tickerMatchIndex=-1}else tickerMatches=tickerNodePaths(ticker);if(!tickerMatches.length){selectedTickerPath=null;status.textContent='未找到';return 0}tickerMatchIndex=(tickerMatchIndex+1)%tickerMatches.length;selectTickerNode(tickerMatches[tickerMatchIndex],ticker);status.textContent=`第 ${tickerMatchIndex+1}/${tickerMatches.length} 处`;return tickerMatches.length}
function definitionNodeAtPath(path){let raw=strategy.definition?.incantation||strategy.definition;if(!raw)return null;const parts=path.split('-').map(Number);if(parts.shift()!==0)return null;for(const index of parts){const children=raw.incantation_type==='IfElse'?[raw.then_incantation,raw.else_incantation]:(raw.incantations||raw.children||raw.nodes||raw.items||raw.assets||[]);raw=children[index];if(!raw)return null}return raw}
function replaceTickerInOwnDefinition(value,pattern,replacement,counter){if(typeof value==='string')return value.replace(pattern,()=>{counter.count++;return replacement});if(Array.isArray(value))return value.map(item=>replaceTickerInOwnDefinition(item,pattern,replacement,counter));if(value&&typeof value==='object'){for(const key of Object.keys(value)){if(['incantations','then_incantation','else_incantation','children','nodes','items','assets'].includes(key))continue;value[key]=replaceTickerInOwnDefinition(value[key],pattern,replacement,counter)}}return value}
$('#tickerFindBtn').onclick=findTicker;
$('#tickerFind').onkeydown=e=>{if(e.key==='Enter')findTicker()};
$('#tickerReplace').onkeydown=e=>{if(e.key==='Enter')$('#tickerReplaceBtn').click()};
$('#tickerReplaceBtn').onclick=()=>{const from=$('#tickerFind').value.trim().toUpperCase(),to=$('#tickerReplace').value.trim().toUpperCase(),status=$('#tickerReplaceStatus');if(!validTicker(from)||!validTicker(to)){status.textContent='代码无效';return}if(from===to){status.textContent='代码相同';return}if(!selectedTickerPath||!tickerRegex(from).test(`${nodeAt(selectedTickerPath)?.title||''} ${nodeAt(selectedTickerPath)?.meta||''}`)){status.textContent='请先查找并选中';return}const node=nodeAt(selectedTickerPath),counter={count:0};node.title=replaceTickerDeep(node.title,tickerRegex(from),to,counter);node.meta=replaceTickerDeep(node.meta,tickerRegex(from),to,counter);const raw=definitionNodeAtPath(selectedTickerPath);if(raw)replaceTickerInOwnDefinition(raw,tickerRegex(from),to,{count:0});snapshot();renderTree();selectTickerNode(selectedTickerPath,to);tickerMatchQuery='';status.textContent='已替换当前节点';toast(`仅当前选中的 ${from} 已替换为 ${to}，保存前可撤销`)};
$('#tickerReplaceAllBtn').onclick=()=>{const from=$('#tickerFind').value.trim().toUpperCase(),to=$('#tickerReplace').value.trim().toUpperCase(),status=$('#tickerReplaceStatus');if(!validTicker(from)||!validTicker(to)){status.textContent='代码无效';return}if(from===to){status.textContent='代码相同';return}const nodes=tickerNodePaths(from).length;if(!nodes){status.textContent='未找到';return}const counter={count:0};replaceTickerDeep(strategy.nodes,tickerRegex(from),to,counter);if(strategy.definition)replaceTickerDeep(strategy.definition,tickerRegex(from),to,{count:0});snapshot();renderTree();selectedTickerPath=null;tickerMatchQuery='';status.textContent=`已全部替换 ${nodes} 处`;toast(`${from} 的 ${nodes} 个节点已全部替换为 ${to}，保存前可撤销`)};
$('#tickerUndoBtn').onclick=()=>{if(historyIndex<=0)return;restore(historyIndex-1);selectedTickerPath=null;tickerMatchQuery='';$('#tickerReplaceStatus').textContent='已撤销';toast('已撤销上一次修改')};
$$('#startDate,#endDate').forEach(input=>input.onclick=()=>{try{input.showPicker()}catch{}});$$('.date-quick button').forEach(button=>button.onclick=()=>{const end=new Date(),period=button.dataset.period,start=new Date(end);if(period==='max')start.setFullYear(2000,0,3);else start.setFullYear(end.getFullYear()-Number(period));const iso=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;$('#startDate').value=iso(start);$('#endDate').value=iso(end);toast(`时间范围已设为${button.textContent}`)});
$('#chartRange').onclick=e=>{if(e.target.dataset.months==null)return;if(!currentResult){toast('请先运行一次真实回测');return}chartMonths=Number(e.target.dataset.months);chartOffset=100;$('#chartSlider').value=100;$('#chartSlider').disabled=!chartMonths;$$('#chartRange button').forEach(b=>b.classList.toggle('active',b===e.target));chart()};$('#chartSlider').oninput=e=>{chartOffset=Number(e.target.value);chart()};$('#logScale').onchange=()=>chart();
$('#builderModes').onclick=e=>{const mode=e.target.dataset.mode;if(!mode)return;$$('#builderModes button').forEach(b=>b.classList.toggle('active',b===e.target));$('#visualEditor').hidden=mode==='code';$('#codeEditor').hidden=mode!=='code';if(mode==='code')$('#strategyCode').value=JSON.stringify(strategy.definition||{nodes:strategy.nodes},null,2)};
$('#formatCode').onclick=()=>{try{$('#strategyCode').value=JSON.stringify(JSON.parse($('#strategyCode').value),null,2);toast('JSON 已格式化')}catch{toast('JSON 格式错误')}};
$('#applyCode').onclick=()=>{try{const d=JSON.parse($('#strategyCode').value),nodes=extractImportedNodes(d);if(!nodes.length)throw Error();strategy.nodes.splice(0,strategy.nodes.length,...nodes);strategy.definition=d.incantation||((d.incantation_type||d.step)?d:(d.definition||null));snapshot();renderTree();toast('代码已应用到策略')}catch{toast('无法识别该策略 JSON')}};
function showAppPage(page,route=true){
  const library=page==='library';
  $('#workspacePage').hidden=library;$('#libraryModal').hidden=!library;
  $$('.topbar nav button').forEach(button=>{const active=library?button.id==='libraryNav':button.dataset.nav==='builder';button.classList.toggle('nav-active',active);if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});
  if(route&&location.hash!==`#${page}`)location.hash=page;
  window.scrollTo(0,0);
  if(!library)requestAnimationFrame(()=>{chart();updateTreeScrollSize();updateAllocationScrollSize()});
}
window.addEventListener('hashchange',()=>{const page=location.hash==='#library'?'library':'builder';showAppPage(page,false);if(page==='library')fetchLibrary()});
function strategyDocument(){return {name:$('#strategyName').value.trim()||'未命名策略',settings:currentSettings(),strategy:clone(strategy)}}
function applyStrategyDocument(document){
  const saved=document||{},s=saved.settings||{};
  $('#strategyName').value=saved.name||'未命名策略';
  strategy.nodes.splice(0,strategy.nodes.length,...clone(saved.strategy?.nodes||[]));
  if(saved.strategy?.definition)strategy.definition=clone(saved.strategy.definition);else delete strategy.definition;
  treeDepthLimit=countNodes(strategy.nodes)>300?3:99;
  for(const [id,key] of [['capital','capital'],['frequency','frequency'],['slippage','slippage'],['benchmark','benchmark'],['startDate','start'],['endDate','end']])if(s[key]!=null)$('#'+id).value=s[key];
  if(s.reinvestDividends!=null)$('#dividends').checked=s.reinvestDividends;
  history=[];historyIndex=-1;renderTree();snapshot();
  localStorage.setItem('atlas-strategy',JSON.stringify(strategyDocument()));
}
async function saveCurrentStrategy(asNew=false){
  const button=$('#saveBtn');button.disabled=true;
  try{
    const document=strategyDocument(),updating=!asNew&&currentStrategyId,url=updating?`/api/strategies/${currentStrategyId}`:'/api/strategies';
    let response=await fetch(url,{method:updating?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(document)});
    if(response.status===404&&currentStrategyId){currentStrategyId=null;response=await fetch('/api/strategies',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(document)})}
    const saved=await response.json();if(!response.ok)throw new Error(saved.detail||'保存失败');
    currentStrategyId=saved.id;localStorage.setItem('atlas-current-strategy-id',currentStrategyId);localStorage.setItem('atlas-strategy',JSON.stringify(document));history=[clone(strategy)];historyIndex=0;selectedTickerPath=null;tickerMatchQuery='';updateUndo();$('#tickerReplaceStatus').textContent='已保存';
    toast(`已保存到策略库 · ${saved.name}`);
    $('#librarySearch').value='';showAppPage('library');await fetchLibrary();
  }catch(error){toast(error.message||'策略保存失败')}finally{button.disabled=false}
}
function createBlankStrategy(confirmFirst=false){
  if(confirmFirst&&!confirm('创建一个新的空白策略？当前未保存改动将保留在最近草稿中。'))return;
  currentStrategyId=null;localStorage.removeItem('atlas-current-strategy-id');$('#strategyName').value='未命名策略';strategy.definition=BuilderModel.group([]);strategy.nodes=[composerToNode(strategy.definition)];history=[];historyIndex=-1;snapshot();renderTree();showAppPage('builder');toast('已创建新策略，点击保存后加入策略库');
}
async function fetchLibrary(){
  const list=$('#libraryList');list.innerHTML='<div class="library-empty">正在读取策略库…</div>';
  try{const response=await fetch('/api/strategies',{cache:'no-store'}),data=await response.json();if(!response.ok)throw Error(data.detail||'读取失败');libraryRows=data;renderLibrary()}catch(error){list.innerHTML=`<div class="library-empty">${safeText(error.message)}</div>`}
}
function renderLibrary(){
  const q=$('#librarySearch').value.trim().toLowerCase(),rows=libraryRows.filter(x=>x.name.toLowerCase().includes(q)),list=$('#libraryList');
  list.innerHTML=rows.length?rows.map(x=>`<div class="library-item" data-id="${x.id}"><div><div class="library-name">${safeText(x.name)}${x.id===currentStrategyId?' · 当前策略':''}</div><div class="library-meta">${x.id.slice(0,8)}</div></div><div class="library-meta">${safeText(x.updatedAt.replace('T',' '))}</div><div class="library-meta">${Math.max(1,Math.round(x.size/1024))} KB</div><div class="library-actions"><button class="library-action open">打开 / 编辑</button><button class="library-action rename">重命名</button><button class="library-action duplicate">复制</button><button class="library-action delete">删除</button></div></div>`).join(''):`<div class="library-empty">${q?'没有匹配的策略，请更换搜索词。':'策略库为空，点击“新建策略”开始。'}</div>`;
}
async function libraryAction(event){
  const button=event.target.closest('.library-action');if(!button)return;const id=button.closest('.library-item').dataset.id,row=libraryRows.find(x=>x.id===id);
  try{
    if(button.classList.contains('open')){const response=await fetch(`/api/strategies/${id}`),document=await response.json();if(!response.ok)throw Error(document.detail);currentStrategyId=id;localStorage.setItem('atlas-current-strategy-id',id);applyStrategyDocument(document);showAppPage('builder');toast(`已打开 · ${document.name}`);return}
    if(button.classList.contains('rename')){const name=(prompt('新的策略名称：',row.name)||'').trim();if(!name)return;const response=await fetch(`/api/strategies/${id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});if(!response.ok)throw Error('重命名失败');if(currentStrategyId===id)$('#strategyName').value=name;await fetchLibrary();toast('策略已重命名');return}
    if(button.classList.contains('duplicate')){const source=await (await fetch(`/api/strategies/${id}`)).json();source.name=`${source.name} 副本`;delete source.id;delete source.createdAt;delete source.updatedAt;const response=await fetch('/api/strategies',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(source)});if(!response.ok)throw Error('复制失败');await fetchLibrary();toast('策略副本已创建');return}
    if(button.classList.contains('delete')){if(!confirm(`确定删除“${row.name}”？此操作无法撤销。`))return;const response=await fetch(`/api/strategies/${id}`,{method:'DELETE'});if(!response.ok)throw Error('删除失败');if(currentStrategyId===id){currentStrategyId=null;localStorage.removeItem('atlas-current-strategy-id')}await fetchLibrary();toast('策略已删除')}
  }catch(error){toast(error.message||'策略库操作失败')}
}
$('#libraryNav').onclick=()=>{showAppPage('library');fetchLibrary()};
$('#libraryRefresh').onclick=fetchLibrary;
$('#closeLibrary').onclick=()=>showAppPage('builder');
$('#librarySearch').oninput=renderLibrary;
$('#libraryNew').onclick=()=>createBlankStrategy(true);
$('#libraryList').onclick=libraryAction;
$$('.topbar nav button[data-nav]').forEach(b=>b.onclick=()=>showAppPage('builder'));
async function checkBackend(){try{const r=await fetch('/api/status'),s=await r.json();$('#ibStatus').textContent=s.ibkrConnected?`盈透已连接 · API ${s.port}`:'盈透 API 未连接';$('#ibDot').style.background=s.ibkrConnected?'var(--green)':'var(--red)';const end=$('#endDate');if(s.latestDataDate&&(!end.value||end.value==='2026-08-31'))end.value=s.latestDataDate}catch{$('#ibStatus').textContent='请使用 server.py 启动';$('#ibDot').style.background='var(--orange)'}}
function restoreSaved(){try{const saved=JSON.parse(localStorage.getItem('atlas-strategy'));if(saved){if(saved.name)$('#strategyName').value=saved.name;if(saved.strategy?.nodes){strategy.nodes.splice(0,strategy.nodes.length,...saved.strategy.nodes);if(saved.strategy.definition)strategy.definition=saved.strategy.definition}const s=saved.settings||{};for(const [id,key] of [['capital','capital'],['frequency','frequency'],['slippage','slippage'],['benchmark','benchmark'],['startDate','start'],['endDate','end']])if(s[key]!=null)$('#'+id).value=s[key];if(s.reinvestDividends!=null)$('#dividends').checked=s.reinvestDividends}const last=JSON.parse(localStorage.getItem('atlas-last-result'));if(last?.dates?.length)renderResult(last)}catch(e){console.warn('无法恢复本地状态',e)}}
bindAllocationScroll();restoreSaved();window.addEventListener('resize',()=>{chart(1);updateTreeScrollSize();updateAllocationScrollSize()});renderTree();snapshot();renderMetrics();tables();bindChartTip();bindTreeViewport();setTimeout(()=>chart(1),20);checkBackend();
