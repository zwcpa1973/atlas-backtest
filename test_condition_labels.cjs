const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('app.js', 'utf8');
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function indicatorLabel('), source.indexOf('function composerToNode(')), context);
const node = {name:'test', condition:{type:'BothIndicators', greater_than:false,
  lh_ticker_symbol:'SPY', lh_indicator:{type:'CurrentPrice',window:0},
  rh_ticker_symbol:'SPY', rh_indicator:{type:'MovingAverage',window:200},
  rh_weight:1, rh_bias:0}};
assert.equal(context.conditionTitle(node), 'test：SPY 当前价格 ＜ SPY 200日均线（SMA）');
const rsi = structuredClone(node);
Object.assign(rsi.condition, {type:'IndicatorAndNumber',greater_than:true,rh_value:0,
  lh_indicator:{type:'RelativeStrengthIndex',window:10}});
assert.equal(context.conditionTitle(rsi), 'test：SPY 10日RSI ＞ 0');
const adjusted = structuredClone(node);
Object.assign(adjusted.condition,{rh_weight:0.9,rh_bias:-2,rh_days_ago:1});
assert.match(context.conditionTitle(adjusted), /200日均线（SMA）（1日前）\) × 0.9 − 2/);
const original = JSON.stringify(node);
context.strategy = {definition:{...node,incantation_type:'IfElse'},nodes:[{type:'branch',title:'old'}]};
context.refreshConditionLabels();
assert.equal(context.strategy.nodes[0].title, context.conditionTitle(node));
assert.equal(JSON.stringify(node), original);
console.log('PASS: SMA200, RSI numeric zero, offsets/scaling, cached-label refresh; source condition unchanged');
