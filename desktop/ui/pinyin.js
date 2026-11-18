// 拼音首字母检索。主窗口的设备、摄像头搜索和设置里的挑选弹层共用这一份，
// 避免两边各维护一张表。只覆盖常用字，生僻字按原字匹配。
(() => {
  'use strict';

  const PINYIN_TABLE = {
    a: '阿啊',
    b: '八巴白百摆北被本比壁冰波播不布',
    c: '才采仓草厕插茶柴产长常场唱超车陈成城承池充抽厨窗床吹春磁此从粗存',
    d: '大带单但当刀到灯等低地第电调掉顶定东动都度短对多',
    e: '额',
    f: '发房放飞非风封否夫服福辅复',
    g: '该干感刚高告哥格个给根更工公功供共沟古骨故挂关观管光广柜滚国过',
    h: '哈海含好号合河和黑很红后厚呼湖户花华画换回会活火',
    j: '机加家夹价监检简见件建江将降交脚叫接节结解金进近禁京经净静九酒居局举卷',
    k: '卡开看康抗考科可客空口扣库快宽款框',
    l: '拉来蓝老雷冷离李里理力立连帘凉两亮量列林零领流六楼路滤绿乱',
    m: '马买满慢毛么没每美门面灭民名明模母木目',
    n: '拿哪那内能你年念鸟您牛农暖',
    o: '哦',
    p: '怕排盘跑配朋皮片品平瓶破',
    q: '七期其起气汽器前钱浅墙抢桥切亲轻清情请秋区取全确',
    r: '然让热人认日容肉软',
    s: '三色森沙山扇商上少舌设社身深生声省湿十石时识食使室手书舒数刷双水睡顺说丝四送速',
    t: '他台太谈汤堂躺套特提天条听停通同头图土推厅调',
    w: '外完晚万网危为围卫温文问卧屋无五雾',
    x: '西吸洗下夏先显线香想向小孝些写新心信星行醒休徐许续悬',
    y: '压牙烟严阳样要也业叶一衣仪以音引隐应影用有右于余鱼雨语浴元圆远院云运',
    z: '杂再在早造增扎照遮这真正支知直只纸制中重周主住转桌自总走足组最左作坐',
  };

  const initials = new Map();
  for (const [initial, chars] of Object.entries(PINYIN_TABLE)) {
    for (const char of chars) initials.set(char, initial);
  }

  function pinyinInitials(text) {
    let result = '';
    for (const char of String(text ?? '')) {
      if (/[a-z0-9]/i.test(char)) result += char.toLowerCase();
      else if (initials.has(char)) result += initials.get(char);
      // 表里查不到的字保持原样，保证按原字搜索仍然可用。
      else if (/[一-鿿]/.test(char)) result += char;
    }
    return result;
  }

  // 把一段文字的可搜索形式拼起来：原文 + 拼音首字母，调用方直接 includes 判断。
  function searchable(...parts) {
    const values = parts
      .flat()
      .filter((part) => part !== null && part !== undefined && part !== '')
      .map((part) => String(part));
    return `${values.join(' ')} ${pinyinInitials(values.join(''))}`.toLowerCase();
  }

  window.MiPinyin = Object.freeze({ pinyinInitials, searchable });
})();
