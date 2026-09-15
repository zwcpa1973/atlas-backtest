const builderIndicators={CurrentPrice:'当前价格 · Current Price',MovingAverage:'均线 · Moving Average',ExponentialMovingAverage:'指数均线 · EMA',RelativeStrengthIndex:'相对强弱 · RSI',CumulativeReturn:'累计收益率 · Cumulative Return',MovingAverageOfReturns:'平均收益率 · MA of Returns',MaxDrawdown:'最大回撤 · Max Drawdown'};
builderIndicators.Volatility='波动率 · Volatility';
function enhanceBuilderNodes() {
  document.querySelectorAll('#tree .node').forEach(element => {
    const path=element.dataset.path, raw=definitionNodeAtPath(path);
    if(!raw)return;
    const allocation=BuilderModel.allocation(strategy.definition.incantation||strategy.definition,path);
    const badge=document.createElement('button');badge.type='button';badge.className='node-allocation';badge.textContent=allocation.label;badge.title=allocation.detail;
    badge.setAttribute('aria-label',`权重 ${allocation.label}，${allocation.detail}`);
    if(allocation.parentPath)badge.onclick=()=>openNodeBuilder(allocation.parentPath,true);
    else badge.disabled=true;
    element.querySelector(':scope > .node-row .node-tag').before(badge);
    if(raw.incantation_type==='Ticker')element.querySelector(':scope > .node-row .node-meta').textContent='股票 / ETF';
    element.querySelectorAll(':scope > .node-row [contenteditable]').forEach(e=>e.contentEditable='false');
    const actions=element.querySelector(':scope > .node-row .node-actions');
    const add=document.createElement('button');add.textContent='＋';add.title='在此模块添加股票或指标分支';add.onclick=()=>openNodeBuilder(path);
    const edit=document.createElement('button');edit.textContent='编辑';edit.title='编辑股票或指标条件';edit.onclick=()=>openNodeBuilder(path,true);
    actions.prepend(add,edit);
    actions.querySelector('.delete').onclick=()=>{
      if(confirm('删除此节点及其子节点？保存前可以撤销。'))commitBuilderChange(path,'delete');
    };
    actions.querySelector('.duplicate').onclick=()=>commitBuilderChange(path,'duplicate');
    if(raw.incantation_type==='IfElse'&&(!raw.condition?.condition_type||raw.condition.condition_type==='SingleCondition'))addInlineCondition(element,path,raw);
  });
}
function addInlineCondition(element,path,raw){
  const c=raw.condition||{},form=document.createElement('form');form.className='inline-condition';
  form.hidden=true;form.id=`condition-parameters-${path}`;
  const toggle=document.createElement('button');toggle.type='button';toggle.className='toggle-condition-parameters';
  toggle.textContent='展开参数';toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-controls',form.id);
  toggle.onclick=()=>{
    form.hidden=!form.hidden;
    toggle.textContent=form.hidden?'展开参数':'收起参数';
    toggle.setAttribute('aria-expanded',String(!form.hidden));
    requestAnimationFrame(updateTreeScrollSize);
  };
  element.querySelector(':scope > .node-row .node-actions').prepend(toggle);
  const field=(tag,label,value,options)=>{
    const wrap=document.createElement('label');wrap.append(document.createTextNode(label));
    const input=document.createElement(tag);
    if(options)for(const [key,text]of Object.entries(options)){const option=document.createElement('option');option.value=key;option.textContent=text;input.append(option);}
    else input.type=typeof value==='number'?'number':'text';
    input.value=value;input.setAttribute('aria-label',label);wrap.append(input);form.append(wrap);return input;
  };
  const lhs=field('select','左侧指标',c.lh_indicator?.type,builderIndicators);
  const lw=field('input','周期 / 日',c.lh_indicator?.window||20);
  const ls=field('input','股票',c.lh_ticker_symbol||'SPY');
  const op=field('select','比较',c.greater_than?'gt':'lt',{lt:'小于 ＜',gt:'大于 ＞'});
  const numeric=c.type==='IndicatorAndNumber';
  const rhs=field(numeric?'input':'select',numeric?'右侧数值':'右侧指标',numeric?(c.rh_value??c.rh_value_int??0):c.rh_indicator?.type,numeric?null:builderIndicators);
  let rw,rs;
  if(!numeric){rw=field('input','周期 / 日',c.rh_indicator?.window||20);rs=field('input','股票',c.rh_ticker_symbol||'SPY');}
  const days=field('input','连续 / 日',c.for_days||1);
  const button=document.createElement('button');button.type='submit';button.textContent='应用';form.append(button);
  const more=document.createElement('button');more.type='button';more.textContent='更多设置';more.onclick=()=>openNodeBuilder(path,true);form.append(more);
  const status=document.createElement('span');status.className='inline-condition-status';status.setAttribute('role','status');form.append(status);
  function sync(){lw.disabled=lhs.value==='CurrentPrice';if(rw)rw.disabled=rhs.value==='CurrentPrice';}
  form.onchange=()=>{sync();status.textContent='待应用';};sync();
  form.onsubmit=event=>{
    event.preventDefault();
    try{
      const period=input=>{const n=Number(input.value);if(!Number.isInteger(n)||n<1)throw Error('周期和连续天数必须为正整数');return n;};
      if(!builderIndicators[lhs.value]||(!numeric&&!builderIndicators[rhs.value]))throw Error('请选择支持的指标');
      const node=clone(raw);Object.assign(node.condition,{lh_ticker_symbol:BuilderModel.ticker(ls.value).symbol,lh_indicator:{type:lhs.value,window:lhs.value==='CurrentPrice'?0:period(lw)},greater_than:op.value==='gt',for_days:period(days)});
      if(numeric){if(rhs.value.trim()===''||!Number.isFinite(Number(rhs.value)))throw Error('数值无效');node.condition.rh_value=Number(rhs.value);}
      else Object.assign(node.condition,{rh_ticker_symbol:BuilderModel.ticker(rs.value).symbol,rh_indicator:{type:rhs.value,window:rhs.value==='CurrentPrice'?0:period(rw)}});
      commitBuilderChange(path,'edit',node);
    }catch(error){status.textContent=error.message;}
  };
  element.querySelector(':scope > .node-row').after(form);
}
function commitBuilderChange(path,operation,node,leg) {
  try {
    strategy.definition=BuilderModel.change(strategy.definition,path,operation,node,leg);
    strategy.nodes=[composerToNode(strategy.definition.incantation||strategy.definition)];
    selectedTickerPath=null;tickerMatchQuery='';snapshot();renderTree();
    const notice=$('#backtestNotice');notice.textContent='策略已修改，请重新运行回测；当前结果为修改前结果';notice.className='backtest-notice';
    toast('已更新策略，可撤销；点击保存写入策略库');return true;
  }catch(error){toast(error.message);return false;}
}
function openNodeBuilder(path='0',editing=false) {
  if(!strategy.definition?.incantation_type&&!strategy.definition?.incantation?.incantation_type){
    if(strategy.nodes.length){toast('此策略仅有展示节点，请导入完整策略 JSON，或新建策略后使用可视化编辑');return;}
    strategy.definition=BuilderModel.group([]);
  }
  const target=BuilderModel.at(strategy.definition.incantation||strategy.definition,path);
  if(!target)return;
  if(editing&&!['Ticker','IfElse','Weighted'].includes(target.incantation_type)){toast('此筛选模块请使用代码编辑器编辑；可以通过＋添加股票或条件');return;}
  if(editing&&target.incantation_type==='IfElse'&&target.condition?.condition_type&&target.condition.condition_type!=='SingleCondition'){toast('复合条件请在代码编辑器中编辑，避免丢失原有条件');return;}
  const dialog=$('#nodeBuilder'),form=$('#nodeBuilderForm');form.reset();
  $('#nodeBuilderTitle').textContent=editing?'编辑节点':'添加股票 / 指标条件 / 分支';
  $('#nodeTarget').textContent=`位置：${nodeAt(path)?.title||'根组合'}`;
  $('#nodeKind').value=editing?(target.incantation_type==='Ticker'?'stock':target.incantation_type==='IfElse'?'condition':'group'):'stock';
  $('#nodeKind').disabled=editing;
  $('#nodePlacement').hidden=editing||target.incantation_type!=='IfElse';
  $('#nodeAddNote').hidden=editing;
  $('#nodeAddNote').textContent=target.type==='Custom'?'新增子节点占组合的 1/(原节点数+1)，原有权重按比例缩减；可在组合编辑中调整。':target.incantation_type==='Filtered'?'新增节点参与原有指标排序筛选。':'加入组合时沿用组合分配方式；若位置是单个股票，将组成新的等权组合。';
  $('#nodeSymbol').value=target.incantation_type==='Ticker'?target.symbol:'SPY';
  $('#nodeName').value=editing?(target.name||''):'';
  $('#groupType').value=target.type||'Equal';$('#groupWindow').value=target.inverse_volatility_window||20;
  $('#groupWeights').value=(target.weights||[]).map(w=>Number((w*100).toFixed(6))).join(', ');
  $('#groupWeightHint').textContent=`此组合有 ${target.incantations?.length||0} 个子节点，按树中顺序填写百分比（总和 100）。`;
  const c=editing?target.condition||{}:{};
  const values={lhsSymbol:c.lh_ticker_symbol||'SPY',lhsIndicator:c.lh_indicator?.type||'CurrentPrice',lhsWindow:c.lh_indicator?.window||20,lhsAgo:c.lh_days_ago||0,compare:c.greater_than?'gt':'lt',rhsMode:c.type==='IndicatorAndNumber'?'number':'indicator',rhsSymbol:c.rh_ticker_symbol||'SPY',rhsIndicator:c.rh_indicator?.type||'MovingAverage',rhsWindow:c.rh_indicator?.window||200,rhsAgo:c.rh_days_ago||0,rhsNumber:c.rh_value??c.rh_value_int??30,conditionDays:c.for_days||1,rhsWeight:c.rh_weight??1,rhsBias:c.rh_bias??0,thenSymbol:'QQQ',elseSymbol:'BIL'};
  for(const [id,value]of Object.entries(values))$('#'+id).value=value;
  $('#newBranchAssets').hidden=editing;
  function updateFields(){
    const kind=$('#nodeKind').value;
    $('#stockFields').hidden=kind!=='stock';$('#conditionFields').hidden=kind!=='condition';$('#groupFields').hidden=kind!=='group';
    $('#rhsIndicatorFields').hidden=$('#rhsMode').value!=='indicator';$('#rhsNumberFields').hidden=$('#rhsMode').value!=='number';
    for(const side of ['lhs','rhs'])$('#'+side+'Window').disabled=$('#'+side+'Indicator').value==='CurrentPrice';
  }
  form.onchange=updateFields;updateFields();
  form.onsubmit=event=>{
    event.preventDefault();$('#nodeBuilderError').textContent='';
    try {
      const value=id=>$('#'+id).value, number=id=>{const v=Number(value(id));if(!Number.isFinite(v)||value(id).trim()==='')throw Error('请填写有效数字');return v;};
      const symbol=id=>BuilderModel.ticker(value(id)).symbol;
      const integer=(id,min=1)=>{const v=number(id);if(!Number.isInteger(v)||v<min)throw Error('周期和天数必须为有效整数');return v;};
      let node;
      if(value('nodeKind')==='stock')node={...(editing?target:{}),...BuilderModel.ticker(value('nodeSymbol'))};
      else if(value('nodeKind')==='group') {
        node={...target,name:value('nodeName').trim(),type:value('groupType'),inverse_volatility_window:integer('groupWindow')};
        if(node.type==='Custom') {
          const weights=value('groupWeights').split(/[,，\s]+/).filter(Boolean).map(Number);
          if(weights.length!==node.incantations.length||weights.some(w=>!Number.isFinite(w)||w<0)||Math.abs(weights.reduce((a,b)=>a+b,0)-100)>.001)throw Error('自定义权重数量需与子节点一致，且合计为 100%');
          node.weights=weights.map(w=>w/100);
        }
      } else {
        const indicator=side=>({type:value(side+'Indicator'),window:value(side+'Indicator')==='CurrentPrice'?0:integer(side+'Window')});
        node={...(editing?target:{}),incantation_type:'IfElse',name:value('nodeName').trim()||'指标条件',condition:{...c,condition_type:'SingleCondition',type:value('rhsMode')==='number'?'IndicatorAndNumber':'BothIndicators',greater_than:value('compare')==='gt',for_days:integer('conditionDays'),lh_ticker_symbol:symbol('lhsSymbol'),lh_indicator:indicator('lhs'),lh_days_ago:integer('lhsAgo',0),rh_weight:number('rhsWeight'),rh_bias:number('rhsBias')}};
        if(value('rhsMode')==='number')node.condition.rh_value=number('rhsNumber');
        else Object.assign(node.condition,{rh_ticker_symbol:symbol('rhsSymbol'),rh_indicator:indicator('rhs'),rh_days_ago:integer('rhsAgo',0)});
        if(!editing){node.then_incantation=BuilderModel.ticker(value('thenSymbol'));node.else_incantation=BuilderModel.ticker(value('elseSymbol'));}
      }
      if(commitBuilderChange(path,editing?'edit':'add',node,value('nodeLeg')))dialog.close();
    }catch(error){$('#nodeBuilderError').textContent=error.message;}
  };
  $('#nodeBuilderError').textContent='';dialog.showModal();
}
function initNodeBuilder(){
  document.querySelectorAll('.indicator-options').forEach(select=>{const option=document.createElement('option');option.value='Volatility';option.textContent='波动率 Volatility（日收益标准差 %）';select.append(option);});
  $('#addRoot').onclick=()=>openNodeBuilder('0');
  $('#closeNodeBuilder').onclick=()=>$('#nodeBuilder').close();
  $('#cancelNodeBuilder').onclick=()=>$('#nodeBuilder').close();
}
