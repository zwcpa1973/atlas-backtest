/* Native QuantMage definitions remain the single source of truth. */
const BuilderModel = (() => {
  const copy = value => JSON.parse(JSON.stringify(value));
  const ticker = symbol => {
    symbol = String(symbol || '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.^-]{0,14}$/.test(symbol)) throw Error('请输入有效股票代码');
    return {incantation_type:'Ticker', symbol};
  };
  const group = children => ({incantation_type:'Weighted',type:'Equal',name:'等权组合',incantations:children});
  function at(root, path) {
    const parts = path.split('-').map(Number);
    if (parts.shift() !== 0) throw Error('节点路径无效');
    return parts.reduce((node, i) => node.incantation_type === 'IfElse'
      ? [node.then_incantation,node.else_incantation][i] : node.incantations?.[i], root);
  }
  function replace(root, path, node) {
    if (path === '0') return node;
    const parts=path.split('-'), index=Number(parts.pop()), parent=at(root,parts.join('-'));
    if(parent.incantation_type==='IfElse')parent[index===0?'then_incantation':'else_incantation']=node;
    else parent.incantations[index]=node;
    return root;
  }
  function append(parent,node) {
    if(!['Weighted','Filtered','Filter'].includes(parent.incantation_type))return group([parent,node]);
    const count=parent.incantations.length;
    if(parent.type==='Custom') {
      const weights=parent.weights;
      if(!Array.isArray(weights)||weights.length!==count)throw Error('原组合自定义权重数量不匹配，请先修正');
      const total=weights.reduce((a,b)=>a+Number(b),0);
      if(count && !(total>0))throw Error('原组合权重无效');
      parent.weights=weights.map(w=>Number(w)/total*count/(count+1));
      parent.weights.push(1/(count+1));
    }
    parent.incantations.push(node);
    return parent;
  }
  function change(definition,path,operation,node,leg='then') {
    let document=copy(definition),root=document.incantation||document;
    const target=at(root,path);
    if(!target)throw Error('目标节点不存在，请重新选择');
    if(operation==='edit')root=replace(root,path,copy(node));
    else if(operation==='add') {
      if(target.incantation_type==='IfElse') {
        const key=leg==='else'?'else_incantation':'then_incantation';
        target[key]=append(target[key],copy(node));
      } else root=replace(root,path,append(target,copy(node)));
    } else if(operation==='delete'||operation==='duplicate') {
      if(path==='0') {
        root=operation==='delete'?group([]):group([root,copy(root)]);
      } else {
        const parts=path.split('-'),index=Number(parts.pop()),parent=at(root,parts.join('-'));
        if(parent.incantation_type==='IfElse')throw Error('THEN / ELSE 分支不能直接删除或复制，请编辑分支或其内部组合');
        if(operation==='delete') {
          if(parent.incantations.length===1)throw Error('组合至少保留一个节点；可以删除上级组合');
          parent.incantations.splice(index,1);
          if(parent.type==='Custom')parent.weights.splice(index,1);
        } else {
          parent.incantations.splice(index+1,0,copy(target));
          if(parent.type==='Custom') {const half=Number(parent.weights[index])/2;parent.weights.splice(index,1,half,half);}
        }
      }
    } else throw Error('不支持的操作');
    if(document.incantation)document.incantation=root;else document=root;
    return document;
  }
  function allocation(root,path){
    if(path==='0')return {label:'100%',detail:'策略根节点：整体资金 100%'};
    const parts=path.split('-'),index=Number(parts.pop()),parent=at(root,parts.join('-'));
    const percent=value=>`${Number((value*100).toFixed(2))}%`;
    if(parent.incantation_type==='IfElse')return {label:'选中时 100%',detail:'仅条件选中的分支承接父级全部资金；THEN 与 ELSE 不同时持仓'};
    if(parent.incantation_type==='Weighted'){
      const mode=parent.type||'Equal',count=parent.incantations.length;
      if(mode==='Equal')return {label:percent(1/count),detail:`占父组合的权重：${count} 个子节点等权分配`,parentPath:parts.join('-')};
      if(mode==='Custom'){
        const weights=parent.weights;
        if(!Array.isArray(weights)||weights.length!==count||weights.some(w=>!Number.isFinite(Number(w))||Number(w)<0))return {label:'权重无效',detail:'请编辑父组合，检查自定义权重'};
        const total=weights.reduce((sum,w)=>sum+Number(w),0);
        if(total<=0)return {label:'权重无效',detail:'父组合权重总和必须大于零'};
        return {label:percent(Number(weights[index])/total),detail:'占父组合的归一化权重，不是占整个策略的最终持仓比例；点击编辑父组合权重',parentPath:parts.join('-')};
      }
      if(mode==='InverseVolatility')return {label:'动态权重',detail:'按父组合中各子节点的波动率倒数分配，随日期变化',parentPath:parts.join('-')};
    }
    return {label:'筛选后分配',detail:'是否选中及实际权重由父模块运行时决定'};
  }
  return {ticker,group,at,change,allocation};
})();
if(typeof module!=='undefined')module.exports=BuilderModel;
