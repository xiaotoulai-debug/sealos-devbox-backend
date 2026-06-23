/**
 * eMAG 平台佣金费率字典（本地静态规则引擎）
 *
 * 数据来源：业务侧客户经理提供的《eMAG 类目佣金费率表》完整版
 * 最后更新：2026-04-09
 *
 * 维护说明：
 *   - 新增品类：在对应费率分组下追加条目，并同步补充 keywordsEn/Ro/Zh
 *   - 费率调整：修改 rate 字段，重新运行 npm run ops:init-profit 即可生效
 *   - 字典按费率从低到高排列，匹配引擎按顺序扫描，第一个命中即返回
 *
 * 关键词规范：
 *   - 全部小写，匹配时统一转小写，大小写不敏感
 *   - 多词短语（含空格）优先于单词匹配，避免"tv"误命中"activity"
 *   - 中文关键词对应本地 Product.category 字段；英/罗语对应 StoreProduct.name
 */

export interface CommissionRule {
  rate:        number;
  label:       string;
  keywordsEn:  string[];
  keywordsRo:  string[];
  keywordsZh:  string[];
}

export const COMMISSION_RULES: CommissionRule[] = [

  // ══════════════════════════════════════════════════════════
  // 2%
  // ══════════════════════════════════════════════════════════
  {
    rate: 0.02,
    label: '汽车整车',
    keywordsEn: ['automobile for sale', 'new car', 'used car', 'car sale listing'],
    keywordsRo: ['autoturism de vanzare', 'masina de vanzare'],
    keywordsZh: ['整车', '新车', '二手车'],
  },
  {
    rate: 0.02,
    label: '燃油券',
    keywordsEn: ['fuel voucher', 'petrol voucher', 'gas voucher', 'fuel card'],
    keywordsRo: ['voucher combustibil', 'voucher benzina', 'vouchere combustibil'],
    keywordsZh: ['燃油券', '加油卡', '油票'],
  },
  {
    rate: 0.02,
    label: '拖拉机与工程机械',
    keywordsEn: ['tractor', 'construction machine', 'excavator', 'bulldozer', 'forklift'],
    keywordsRo: ['tractor', 'tractoare', 'utilaj constructii', 'excavator', 'buldozer'],
    keywordsZh: ['拖拉机', '工程机械', '挖掘机', '推土机', '叉车'],
  },

  // ══════════════════════════════════════════════════════════
  // 5%
  // ══════════════════════════════════════════════════════════
  {
    rate: 0.05,
    label: '贵金属硬币金条',
    keywordsEn: ['gold coin', 'silver coin', 'gold bar', 'silver bar', 'precious metals', 'bullion'],
    keywordsRo: ['monede aur', 'monede argint', 'lingouri aur', 'monede si lingouri', 'metale pretioase'],
    keywordsZh: ['金条', '银条', '金币', '银币', '贵金属', '黄金'],
  },

  // ══════════════════════════════════════════════════════════
  // 6%
  // ══════════════════════════════════════════════════════════
  {
    rate: 0.06,
    label: '预付卡套装',
    keywordsEn: ['prepaid card', 'pre-paid set', 'sim card', 'recharge card'],
    keywordsRo: ['cartela prepaid', 'cartele pre-paid', 'cartelă', 'reîncărcare'],
    keywordsZh: ['预付卡', '充值卡', 'SIM卡', '电话卡'],
  },

  // ══════════════════════════════════════════════════════════
  // 8%
  // ══════════════════════════════════════════════════════════
  {
    rate: 0.08,
    label: '医疗耗材口罩测试剂',
    keywordsEn: ['surgical mask', 'face mask', 'covid test', 'covid-19 test', 'rapid test', 'ffp2', 'n95'],
    keywordsRo: ['masca chirurgicala', 'masti chirurgicale', 'test covid', 'teste covid-19', 'test rapid'],
    keywordsZh: ['口罩', '外科口罩', '新冠测试', 'COVID检测', '快速检测'],
  },
  {
    rate: 0.08,
    label: '猪肉胴体',
    keywordsEn: ['pork carcass', 'pig carcass', 'whole pig', 'half pig'],
    keywordsRo: ['carcasa porc', 'carcase porc', 'porc intreg'],
    keywordsZh: ['猪肉胴体', '整猪', '生猪'],
  },

  // ══════════════════════════════════════════════════════════
  // 9%
  // ══════════════════════════════════════════════════════════
  {
    rate: 0.09,
    label: '相机即时卡片无反',
    keywordsEn: [
      'instant camera', 'compact camera', 'mirrorless camera', 'mirrorless',
      'dslr', 'digital camera', 'camera body', 'camera lens',
    ],
    keywordsRo: ['aparat foto', 'aparate foto', 'camera foto', 'obiectiv foto'],
    keywordsZh: ['相机', '微单', '单反', '卡片机', '拍立得'],
  },
  {
    rate: 0.09,
    label: '电视机',
    keywordsEn: [
      'television', 'smart tv', '4k tv', 'oled tv', 'qled tv', 'led tv',
      'uhd tv', 'tv 55', 'tv 65', 'tv 43', 'tv inch',
    ],
    keywordsRo: ['televizor', 'televizoare', 'tv smart', 'tv led', 'tv oled'],
    keywordsZh: ['电视', '电视机', '智能电视', '液晶电视'],
  },
  {
    rate: 0.09,
    label: '电信服务',
    keywordsEn: ['mobile service', 'internet subscription', 'tv subscription', 'telecom service'],
    keywordsRo: ['servicii de telefonie', 'servicii internet', 'abonament telefonie', 'servicii televiziune'],
    keywordsZh: ['电信服务', '手机套餐', '网络服务', '电话订阅'],
  },
  {
    rate: 0.09,
    label: '建筑材料水泥砂浆',
    keywordsEn: ['cement', 'mortar', 'concrete additive', 'construction additive'],
    keywordsRo: ['ciment', 'mortar', 'aditiv beton', 'aditiv constructii'],
    keywordsZh: ['水泥', '砂浆', '混凝土添加剂'],
  },
  {
    rate: 0.09,
    label: '游艇和船只',
    keywordsEn: ['yacht', 'boat', 'motorboat', 'sailboat', 'inflatable boat'],
    keywordsRo: ['yacht', 'yacht-uri', 'barca', 'barci', 'ambarcatiune'],
    keywordsZh: ['游艇', '船只', '摩托艇', '帆船', '橡皮艇'],
  },

  // ══════════════════════════════════════════════════════════
  // 10%
  // ══════════════════════════════════════════════════════════
  {
    rate: 0.10,
    label: '显示器LCD/LED',
    keywordsEn: ['lcd monitor', 'led monitor', 'computer monitor', 'gaming monitor', 'curved monitor', 'ultrawide monitor'],
    keywordsRo: ['monitor lcd', 'monitor led', 'monitoare lcd', 'monitoare led', 'monitor gaming', 'monitor pc'],
    keywordsZh: ['显示器', '电脑显示器', '液晶显示器', '曲面屏', '游戏显示器'],
  },
  {
    rate: 0.10,
    label: '中央供暖与热泵',
    keywordsEn: ['central heating', 'heat pump', 'heating pump', 'thermal system', 'underfloor heating'],
    keywordsRo: ['centrala termica', 'centrale termice', 'pompa caldura', 'pompe caldura', 'incalzire pardoseala'],
    keywordsZh: ['中央供暖', '热泵', '暖气系统', '地暖'],
  },
  {
    rate: 0.10,
    label: '卫生防疫消毒手套',
    keywordsEn: ['antibacterial gel', 'hand sanitizer', 'disinfectant', 'latex gloves', 'nitrile gloves', 'rubber gloves'],
    keywordsRo: ['gel antibacterian', 'gel dezinfectant', 'dezinfectant', 'manusi latex', 'manusi nitril', 'manusi chirurgicale'],
    keywordsZh: ['消毒', '手部消毒', '消毒剂', '乳胶手套', '橡胶手套'],
  },
  {
    rate: 0.10,
    label: '劳保用品',
    keywordsEn: ['safety glasses', 'work safety', 'protective goggles', 'safety helmet', 'safety vest', 'work gloves'],
    keywordsRo: ['ochelari protectia muncii', 'ochelari protectie', 'casca protectie', 'vesta reflectorizanta', 'manusi lucru'],
    keywordsZh: ['劳保用品', '安全眼镜', '防护眼镜', '安全帽', '反光背心'],
  },
  {
    rate: 0.10,
    label: '活动门票',
    keywordsEn: ['event ticket', 'concert ticket', 'theater ticket', 'sport event ticket'],
    keywordsRo: ['bilet eveniment', 'bilete evenimente', 'bilet concert', 'bilet teatru'],
    keywordsZh: ['门票', '演出票', '音乐会票', '活动票'],
  },

  // ══════════════════════════════════════════════════════════
  // 11%
  // ══════════════════════════════════════════════════════════
  {
    rate: 0.11,
    label: '汽车电池',
    keywordsEn: ['car battery', 'auto battery', 'vehicle battery', 'lead acid battery', 'agm battery'],
    keywordsRo: ['baterie auto', 'baterii auto', 'acumulator auto', 'baterie masina'],
    keywordsZh: ['汽车电池', '车用电池', '蓄电池', '汽车蓄电池'],
  },

  // ══════════════════════════════════════════════════════════
  // 12%
  // ══════════════════════════════════════════════════════════
  {
    rate: 0.12,
    label: '电脑组件CPU显卡主板',
    keywordsEn: [
      'processor', 'cpu', 'video card', 'gpu', 'graphics card',
      'motherboard', 'mainboard', 'ram memory', 'desktop memory',
    ],
    keywordsRo: ['procesor', 'procesoare', 'placa video', 'placi video', 'placa de baza', 'memorie ram'],
    keywordsZh: ['处理器', 'CPU', '显卡', '主板', '内存条', '电脑组件'],
  },
  {
    rate: 0.12,
    label: '硬盘SSD',
    keywordsEn: ['hdd', 'ssd', 'hard disk', 'hard drive', 'solid state drive', 'nvme', 'internal hard drive', 'm.2 ssd'],
    keywordsRo: ['hard disk', 'hard disk-uri', 'ssd', 'solid state drive', 'nvme', 'stocare interna'],
    keywordsZh: ['硬盘', 'SSD', '固态硬盘', '机械硬盘', '存储'],
  },
  {
    rate: 0.12,
    label: '轮胎各类型',
    keywordsEn: ['car tire', 'car tyre', 'truck tire', 'motorcycle tire', 'winter tire', 'summer tire', 'all season tire'],
    keywordsRo: ['anvelopa', 'anvelope', 'anvelopa vara', 'anvelopa iarna', 'anvelopa all season'],
    keywordsZh: ['轮胎', '汽车轮胎', '卡车轮胎', '冬季轮胎', '夏季轮胎'],
  },
  {
    rate: 0.12,
    label: '摩托车ATV滑板车',
    keywordsEn: ['motorcycle', 'motorbike', 'scooter moto', 'atv', 'quad bike', 'snowmobile'],
    keywordsRo: ['motocicleta', 'motociclete', 'scuter', 'scutere', 'atv', 'moped', 'snowmobil'],
    keywordsZh: ['摩托车', 'ATV', '沙滩车', '雪地摩托', '轻便摩托'],
  },
  {
    rate: 0.12,
    label: '母婴纸尿裤',
    keywordsEn: ['diaper', 'nappy', 'baby diaper', 'baby nappy', 'pull-up pants baby', 'pampers'],
    keywordsRo: ['scutec', 'scutece', 'scutece bebelus', 'chilotei scutec', 'pampers'],
    keywordsZh: ['纸尿裤', '尿不湿', '婴儿纸尿裤', '拉拉裤', '尿布'],
  },
  {
    rate: 0.12,
    label: '香水',
    keywordsEn: ['perfume', 'cologne', 'eau de toilette', 'eau de parfum', 'fragrance', 'aftershave'],
    keywordsRo: ['parfum', 'parfumuri', 'apa de toaleta', 'apa de parfum', 'colonie', 'after shave'],
    keywordsZh: ['香水', '古龙水', '淡香水', '浓香水', '香氛'],
  },
  {
    rate: 0.12,
    label: '太阳能系统',
    keywordsEn: ['solar panel', 'photovoltaic', 'solar system', 'solar energy', 'pv panel', 'solar inverter'],
    keywordsRo: ['panou solar', 'panouri solare', 'sistem fotovoltaic', 'fotovoltaic', 'invertor solar'],
    keywordsZh: ['太阳能', '光伏', '光伏板', '太阳能系统', '太阳能逆变器'],
  },
  {
    rate: 0.12,
    label: '建筑材料砖板材粘合剂',
    keywordsEn: ['brick', 'bca block', 'masonry block', 'tile adhesive', 'construction adhesive', 'grout', 'plasterboard'],
    keywordsRo: ['caramida', 'caramizi', 'bca', 'adeziv gresie', 'adeziv faianta', 'adezivi constructii', 'rigips'],
    keywordsZh: ['砖', 'BCA砖块', '砌块', '瓷砖粘合剂', '建筑粘合剂', '石膏板'],
  },

  // ══════════════════════════════════════════════════════════
  // 13%
  // ══════════════════════════════════════════════════════════
  {
    rate: 0.13,
    label: '车用油液机油变速箱油',
    keywordsEn: ['motor oil', 'engine oil', 'gearbox oil', 'transmission fluid', 'hydraulic oil', 'brake fluid', 'coolant'],
    keywordsRo: ['ulei motor', 'ulei cutie viteze', 'ulei hidraulic', 'lichid frana', 'antigel', 'ulei transmisie'],
    keywordsZh: ['机油', '发动机油', '变速箱油', '液压油', '刹车液', '防冻液'],
  },
  {
    rate: 0.13,
    label: '散热器暖气片',
    keywordsEn: ['heating radiator', 'panel radiator', 'cast iron radiator', 'convector radiator'],
    keywordsRo: ['calorifer', 'calorifere', 'radiator termic', 'convector'],
    keywordsZh: ['散热器', '暖气片', '铸铁散热器', '板式散热器'],
  },
  {
    rate: 0.13,
    label: '拖拉机配件',
    keywordsEn: ['tractor spare part', 'tractor component', 'tractor part'],
    keywordsRo: ['piese tractor', 'piese tractoare', 'componente tractor'],
    keywordsZh: ['拖拉机配件', '拖拉机零件', '农机配件'],
  },

  // ══════════════════════════════════════════════════════════
  // 14%
  // ══════════════════════════════════════════════════════════
  {
    rate: 0.14,
    label: '打印机扫描仪',
    keywordsEn: ['printer', 'scanner', 'multifunction printer', 'mfp', 'laser printer', 'inkjet printer', '3d printer'],
    keywordsRo: ['imprimanta', 'imprimante', 'scanner', 'scannere', 'multifunctionala', 'imprimanta laser', 'imprimanta 3d'],
    keywordsZh: ['打印机', '扫描仪', '多功能一体机', '激光打印机', '喷墨打印机', '3D打印机'],
  },
  {
    rate: 0.14,
    label: '大家电冰洗厨',
    keywordsEn: [
      'refrigerator', 'fridge', 'freezer', 'washing machine', 'cooker', 'stove',
      'dishwasher', 'range hood', 'dryer', 'built-in oven',
    ],
    keywordsRo: [
      'frigider', 'frigidere', 'congelator', 'masina de spalat', 'masini de spalat',
      'aragaz', 'aragazuri', 'masina de vase', 'hota', 'uscator rufe', 'cuptor incorporabil',
    ],
    keywordsZh: ['冰箱', '冰柜', '洗衣机', '灶台', '烹饪炉', '洗碗机', '抽油烟机', '烘干机', '嵌入式烤箱'],
  },
  {
    rate: 0.14,
    label: '影音设备音响家庭影院',
    keywordsEn: ['audio system', 'home cinema', 'soundbar', 'home theater', 'hi-fi system', 'stereo system', 'amplifier'],
    keywordsRo: ['sistem audio', 'sisteme audio', 'soundbar', 'home cinema', 'sistem hi-fi', 'amplificator'],
    keywordsZh: ['音响', '家庭影院', '音箱', '功放', '音响系统', '回音壁', '条形音箱'],
  },
  {
    rate: 0.14,
    label: '电脑散热与电源',
    keywordsEn: ['pc power supply', 'psu', 'cpu cooler', 'pc cooling', 'case fan', 'computer fan', 'liquid cooling'],
    keywordsRo: ['sursa pc', 'surse pc', 'cooler cpu', 'racire pc', 'ventilator carcasa', 'racire lichida'],
    keywordsZh: ['电脑电源', 'PC电源', 'CPU散热', '机箱风扇', '水冷', '风冷'],
  },
  {
    rate: 0.14,
    label: '宠物食品',
    keywordsEn: ['dog food', 'cat food', 'pet food', 'fish food', 'bird food', 'animal feed', 'cat treats', 'dog treats'],
    keywordsRo: ['hrana caini', 'hrana pisici', 'hrana animale', 'hrana pesti', 'hrana pasari', 'recompense pisici', 'recompense caini'],
    keywordsZh: ['猫粮', '狗粮', '宠物食品', '鱼食', '鸟食', '动物饲料', '宠物零食'],
  },
  {
    rate: 0.14,
    label: '电动车自行车滑板车',
    keywordsEn: ['electric bike', 'e-bike', 'ebike', 'electric bicycle', 'electric scooter', 'hoverboard', 'balance board'],
    keywordsRo: ['bicicleta electrica', 'biciclete electrice', 'trotineta electrica', 'trotinete electrice', 'hoverboard'],
    keywordsZh: ['电动车', '电动自行车', '电动滑板车', '平衡车', '电踏车'],
  },
  {
    rate: 0.14,
    label: 'GPS导航',
    keywordsEn: ['gps navigation', 'gps navigator', 'sat nav', 'gps device', 'car navigation'],
    keywordsRo: ['navigatie gps', 'navigatii gps', 'gps auto', 'navigator auto'],
    keywordsZh: ['GPS导航', 'GPS设备', '车载导航', '卫星导航'],
  },
  {
    rate: 0.14,
    label: 'DJ设备与混音',
    keywordsEn: ['dj equipment', 'audio mixer', 'dj controller', 'turntable', 'dj set', 'mixer console'],
    keywordsRo: ['echipament dj', 'echipamente dj', 'mixer audio', 'controller dj', 'pickup dj'],
    keywordsZh: ['DJ设备', '混音台', 'DJ控制器', '转盘'],
  },
  {
    rate: 0.14,
    label: '成人护理纸尿裤避孕套',
    keywordsEn: ['adult diaper', 'adult incontinence', 'condom', 'contraceptive'],
    keywordsRo: ['scutec adult', 'scutece adulti', 'prezervativ', 'prezervative', 'incontinenta'],
    keywordsZh: ['成人纸尿裤', '失禁用品', '避孕套', '安全套'],
  },

  // ══════════════════════════════════════════════════════════
  // 15%
  // ══════════════════════════════════════════════════════════
  {
    rate: 0.15,
    label: '软件系统杀毒Office',
    keywordsEn: ['operating system', 'antivirus software', 'office software', 'windows license', 'software license', 'antivirus'],
    keywordsRo: ['sistem de operare', 'sisteme de operare', 'antivirus', 'licenta office', 'licenta software', 'windows'],
    keywordsZh: ['操作系统', '杀毒软件', 'Office软件', '系统软件', '软件授权'],
  },
  {
    rate: 0.15,
    label: '车间设备与拖车',
    keywordsEn: ['workshop equipment', 'car trailer', 'towing equipment', 'car lift', 'workbench', 'car jack'],
    keywordsRo: ['echipament atelier', 'echipamente atelier', 'remorca', 'remorci', 'elevator auto', 'cricuri auto'],
    keywordsZh: ['车间设备', '拖车', '拖挂车', '汽车举升机', '工作台'],
  },
  {
    rate: 0.15,
    label: '热水器Boilers',
    keywordsEn: ['boiler', 'water heater', 'electric water heater', 'gas water heater', 'instant water heater'],
    keywordsRo: ['boiler', 'boilere', 'boiler electric', 'boiler gaz', 'incalzitor apa'],
    keywordsZh: ['热水器', '电热水器', '燃气热水器', '即热式热水器', '储水热水器'],
  },

  // ══════════════════════════════════════════════════════════
  // 16%
  // ══════════════════════════════════════════════════════════
  {
    rate: 0.16,
    label: '手机屏幕与触摸屏',
    keywordsEn: ['phone display', 'mobile phone display', 'phone screen replacement', 'touch screen replacement', 'lcd phone'],
    keywordsRo: ['display telefon', 'display-uri telefoane', 'ecran telefon', 'touchscreen telefon'],
    keywordsZh: ['手机屏幕', '触摸屏', '手机显示屏', '换屏'],
  },
  {
    rate: 0.16,
    label: '小家电吸尘吹风剃须',
    keywordsEn: [
      'vacuum cleaner', 'robot vacuum', 'cordless vacuum', 'hair dryer', 'hair straightener',
      'curling iron', 'shaver', 'electric razor', 'epilator', 'hair clipper',
    ],
    keywordsRo: [
      'aspirator', 'aspiratoare', 'robot aspirator', 'uscator de par', 'uscatoare par',
      'placa de par', 'ondulator', 'aparat de ras', 'epilator', 'masina de tuns',
    ],
    keywordsZh: ['吸尘器', '扫地机器人', '吹风机', '直发器', '卷发棒', '剃须刀', '脱毛仪', '理发器'],
  },
  {
    rate: 0.16,
    label: '厨房小电搅拌烤煮',
    keywordsEn: [
      'blender', 'hand mixer', 'stand mixer', 'toaster', 'air fryer', 'deep fryer',
      'electric kettle', 'coffee maker', 'espresso machine', 'microwave oven', 'food processor', 'juicer',
    ],
    keywordsRo: [
      'blender', 'blendere', 'mixer', 'mixere', 'prajitor paine', 'prajitoare',
      'friteuza', 'fierbator', 'cafetiera', 'espressor', 'cuptor cu microunde', 'robot bucatarie', 'storcator',
    ],
    keywordsZh: ['搅拌机', '手持搅拌器', '厨师机', '多士炉', '空气炸锅', '电热水壶', '咖啡机', '微波炉', '料理机', '榨汁机'],
  },
  {
    rate: 0.16,
    label: '美妆彩妆护肤洗发',
    keywordsEn: [
      'makeup', 'lipstick', 'foundation', 'mascara', 'eyeshadow', 'concealer',
      'skin cream', 'moisturizer', 'face serum', 'shampoo', 'conditioner', 'body lotion',
    ],
    keywordsRo: [
      'machiaj', 'ruj', 'fond de ten', 'rimel', 'fard de ochi', 'concealer',
      'crema de fata', 'hidratant', 'ser facial', 'sampon', 'balsam de par', 'lotiune corp',
    ],
    keywordsZh: ['彩妆', '口红', '粉底', '睫毛膏', '眼影', '遮瑕', '护肤霜', '精华液', '洗发水', '护发素', '身体乳'],
  },
  {
    rate: 0.16,
    label: '电动工具钻锯磨',
    keywordsEn: ['drill', 'power drill', 'circular saw', 'jigsaw', 'sander', 'angle grinder', 'rotary tool', 'impact driver'],
    keywordsRo: ['masina de gaurit', 'masini de gaurit', 'fierastrau circular', 'fierastrau', 'slefuitor', 'polizor unghiular', 'surubelnita cu impact'],
    keywordsZh: ['电钻', '圆锯', '线锯', '砂光机', '角磨机', '冲击起子'],
  },
  {
    rate: 0.16,
    label: '园艺工具割草水泵',
    keywordsEn: ['lawn mower', 'water pump', 'garden sprayer', 'grass trimmer', 'hedge trimmer', 'chainsaw', 'leaf blower'],
    keywordsRo: ['masina de tuns iarba', 'masini tuns iarba', 'pompa apa', 'atomizor', 'tuns gard viu', 'drujba', 'suflator frunze'],
    keywordsZh: ['割草机', '水泵', '园艺喷雾', '草坪修剪', '绿篱机', '链锯', '吹叶机'],
  },
  {
    rate: 0.16,
    label: '母婴用品推车座椅',
    keywordsEn: ['baby stroller', 'pram', 'pushchair', 'car seat baby', 'child car seat', 'baby monitor', 'baby carrier'],
    keywordsRo: ['carucior', 'carucioare', 'carucior bebe', 'scaun auto copil', 'scaune auto copii', 'monitor bebe', 'marsupiu'],
    keywordsZh: ['婴儿车', '儿童推车', '儿童安全座椅', '婴儿监视器', '婴儿背带'],
  },
  {
    rate: 0.16,
    label: '家具卧室客厅厨房',
    keywordsEn: ['sofa', 'couch', 'armchair', 'bed frame', 'wardrobe', 'bookcase', 'kitchen cabinet', 'dining table', 'coffee table'],
    keywordsRo: ['canapea', 'fotoliu', 'pat dormitor', 'dulap', 'biblioteca', 'corp bucatarie', 'masa sufragerie', 'masa cafea', 'mobilier'],
    keywordsZh: ['沙发', '扶手椅', '床架', '衣柜', '书架', '橱柜', '餐桌', '茶几', '家具'],
  },
  {
    rate: 0.16,
    label: '玩具无人机遥控模型',
    keywordsEn: ['drone', 'quadcopter', 'fpv drone', 'rc car', 'remote control car', 'rc helicopter', 'rc plane', 'rc model'],
    keywordsRo: ['drona', 'drone', 'drona fpv', 'masina rc', 'masina telecomanda', 'elicopter rc', 'avion rc', 'modele rc'],
    keywordsZh: ['无人机', '四轴飞行器', '遥控车', '遥控直升机', '遥控飞机', '遥控模型'],
  },
  {
    rate: 0.16,
    label: '汽配车载音响记录仪逆变器',
    keywordsEn: ['car audio', 'car radio', 'dash cam', 'dashcam', 'car dvr', 'car inverter', 'car amplifier'],
    keywordsRo: ['radio auto', 'camera dvr auto', 'camere dvr', 'camera bord', 'invertor auto', 'amplificator auto'],
    keywordsZh: ['车载音响', '车载收音机', '行车记录仪', '车载逆变器', '汽车功放'],
  },

  // ══════════════════════════════════════════════════════════
  // 17%
  // ══════════════════════════════════════════════════════════
  {
    rate: 0.17,
    label: '乐器吉他提琴钢琴',
    keywordsEn: ['guitar', 'violin', 'piano', 'drum', 'bass guitar', 'ukulele', 'keyboard instrument', 'digital piano', 'microphone stand'],
    keywordsRo: ['chitara', 'chitare', 'vioara', 'viori', 'pian', 'piane', 'tobe', 'instrumente muzicale', 'ukulele'],
    keywordsZh: ['吉他', '小提琴', '钢琴', '鼓', '贝斯', '尤克里里', '电子琴', '乐器'],
  },
  {
    rate: 0.17,
    label: '家居清洁洗涤剂',
    keywordsEn: ['laundry detergent', 'dish detergent', 'surface cleaner', 'fabric softener', 'bleach', 'floor cleaner', 'bathroom cleaner'],
    keywordsRo: ['detergent rufe', 'detergent vase', 'solutie curatare', 'balsam rufe', 'inalbitor', 'detergent pardoseala', 'detergenti'],
    keywordsZh: ['洗衣液', '洗碗液', '清洁剂', '柔顺剂', '漂白剂', '地板清洁剂', '洗涤剂'],
  },
  {
    rate: 0.17,
    label: '汽车内饰脚垫座套',
    keywordsEn: ['car mat', 'floor mat car', 'car seat cover', 'wiper blade', 'windshield wiper', 'car interior', 'car cover'],
    keywordsRo: ['covorase auto', 'covorase masina', 'husa scaun auto', 'stergator parbriz', 'huse auto', 'covor portbagaj'],
    keywordsZh: ['汽车脚垫', '汽车地垫', '座椅套', '雨刮器', '挡风玻璃刮水器', '车内装饰'],
  },
  {
    rate: 0.17,
    label: '个人护理口腔卫生巾',
    keywordsEn: ['toothpaste', 'toothbrush', 'tampon', 'sanitary pad', 'nail polish', 'nail art', 'deodorant', 'bar soap', 'body wash'],
    keywordsRo: ['pasta de dinti', 'pasta dinti', 'periuta de dinti', 'tampon', 'tampoane', 'absorbant', 'oja', 'deodorant', 'sapun', 'gel de dus'],
    keywordsZh: ['牙膏', '牙刷', '卫生巾', '棉条', '指甲油', '除臭剂', '香皂', '沐浴露'],
  },
  {
    rate: 0.17,
    label: '游戏外设手柄椅子',
    keywordsEn: ['gaming chair', 'game controller', 'joystick', 'gamepad', 'playstation', 'xbox controller', 'nintendo', 'gaming headset'],
    keywordsRo: ['scaun gaming', 'scaune gaming', 'controller gaming', 'joystick', 'gamepad', 'casti gaming', 'accesorii console'],
    keywordsZh: ['游戏椅', '游戏手柄', '操纵杆', '游戏耳机', '游戏控制器'],
  },
  {
    rate: 0.17,
    label: '智能手表豪华',
    keywordsEn: ['smartwatch', 'smart watch', 'luxury watch', 'wristwatch', 'fitness tracker', 'sport watch'],
    keywordsRo: ['smartwatch', 'ceas inteligent', 'ceas de lux', 'ceasuri de lux', 'tracker fitness', 'ceas sport'],
    keywordsZh: ['智能手表', '豪华手表', '腕表', '健身追踪器', '运动手表'],
  },

  // ══════════════════════════════════════════════════════════
  // 18%（大量品类，也是 DEFAULT_COMMISSION_RATE 兜底值）
  // ══════════════════════════════════════════════════════════
  {
    rate: 0.18,
    label: '手机配件无线耳机',
    keywordsEn: ['wireless headphone', 'bluetooth headphone', 'earbuds', 'airpods', 'tws earphone', 'wireless earphone', 'in-ear headphone'],
    keywordsRo: ['casti wireless', 'casti bluetooth', 'casti fara fir', 'earbuds', 'casti in-ear'],
    keywordsZh: ['无线耳机', '蓝牙耳机', '真无线耳机', '入耳式耳机'],
  },
  {
    rate: 0.18,
    label: '时尚服饰男女童',
    keywordsEn: ['clothing', 't-shirt', 'jeans', 'jacket', 'shoes', 'sneakers', 'boots', 'underwear', 'sportswear', 'dress', 'coat'],
    keywordsRo: ['imbracaminte', 'incaltaminte', 'tricou', 'pantaloni', 'jacheta', 'pantofi', 'adidasi', 'cizme', 'lenjerie', 'haine', 'rochie'],
    keywordsZh: ['服装', 'T恤', '牛仔裤', '夹克', '鞋', '运动鞋', '靴子', '内衣', '运动服', '连衣裙', '大衣'],
  },
  {
    rate: 0.18,
    label: '箱包与配饰',
    keywordsEn: ['handbag', 'backpack', 'wallet', 'belt', 'sunglasses', 'necklace', 'bracelet', 'jewelry', 'earring', 'ring'],
    keywordsRo: ['geanta', 'genti', 'rucsac', 'portofel', 'portofele', 'curea', 'ochelari de soare', 'bijuterie', 'bijuterii', 'colier', 'bratara'],
    keywordsZh: ['手提包', '背包', '钱包', '腰带', '太阳镜', '项链', '手链', '首饰', '耳环', '戒指'],
  },
  {
    rate: 0.18,
    label: '图书与音像',
    keywordsEn: ['book', 'novel', 'cd album', 'vinyl record', 'dvd film', 'blu-ray', 'audiobook'],
    keywordsRo: ['carte', 'carti', 'cd', 'cd-uri', 'vinil', 'dvd', 'carte audio'],
    keywordsZh: ['图书', '书籍', '小说', 'CD', '黑胶唱片', 'DVD', '有声书'],
  },
  {
    rate: 0.18,
    label: '运动户外健身露营钓鱼',
    keywordsEn: ['fitness equipment', 'camping gear', 'fishing rod', 'bicycle', 'tent', 'sleeping bag', 'trekking', 'hiking boots', 'ski', 'snowboard'],
    keywordsRo: ['echipament fitness', 'camping', 'undita', 'bicicleta', 'cort', 'corturi', 'sac de dormit', 'ski', 'snowboard', 'pescuit'],
    keywordsZh: ['健身器材', '露营装备', '钓鱼竿', '自行车', '帐篷', '睡袋', '徒步靴', '滑雪', '单板滑雪'],
  },
  {
    rate: 0.18,
    label: '网络设备路由交换机',
    keywordsEn: ['router', 'wifi router', 'mesh wifi', 'network switch', 'ethernet switch', 'network card', 'access point'],
    keywordsRo: ['router', 'routere', 'router wifi', 'switch retea', 'switch-uri', 'placa de retea', 'access point'],
    keywordsZh: ['路由器', 'WiFi路由器', '网状WiFi', '网络交换机', '网卡', '无线接入点'],
  },
  {
    rate: 0.18,
    label: '母婴玩具乐高玩偶',
    keywordsEn: ['lego', 'building blocks', 'doll', 'board game', 'baby bottle', 'stuffed animal', 'action figure', 'puzzle game'],
    keywordsRo: ['lego', 'jucarie', 'jucarii', 'papusa', 'joc de societate', 'biberon', 'biberoane', 'plus', 'puzzle'],
    keywordsZh: ['乐高', '积木', '玩偶', '棋盘游戏', '奶瓶', '毛绒玩具', '手办', '拼图游戏'],
  },
  {
    rate: 0.18,
    label: '酒类红酒烈酒',
    keywordsEn: ['wine', 'red wine', 'white wine', 'whisky', 'whiskey', 'vodka', 'beer', 'champagne', 'spirits'],
    keywordsRo: ['vin', 'vinuri', 'vin rosu', 'vin alb', 'whisky', 'vodca', 'bere', 'sampanie', 'bauturi spirtoase'],
    keywordsZh: ['红酒', '白酒', '葡萄酒', '威士忌', '伏特加', '啤酒', '香槟', '烈酒'],
  },
  {
    rate: 0.18,
    label: '营养补充剂',
    keywordsEn: ['protein powder', 'whey protein', 'nutritional supplement', 'vitamin', 'creatine', 'omega 3', 'probiotic', 'collagen'],
    keywordsRo: ['proteine', 'proteina', 'supliment nutritiv', 'suplimente nutritive', 'vitamine', 'vitamina', 'creatina', 'omega 3', 'probiotic'],
    keywordsZh: ['蛋白粉', '营养补充剂', '维生素', '肌酸', '鱼油', '益生菌', '胶原蛋白'],
  },
  {
    rate: 0.18,
    label: '办公家具桌椅',
    keywordsEn: ['office desk', 'standing desk', 'office chair', 'ergonomic chair', 'office furniture', 'conference table'],
    keywordsRo: ['birou', 'birouri', 'scaun de birou', 'scaun ergonomic', 'masa conferinta', 'mobilier birou'],
    keywordsZh: ['办公桌', '站立式办公桌', '办公椅', '人体工学椅', '办公家具', '会议桌'],
  },
  {
    rate: 0.18,
    label: '家纺床品毛巾',
    keywordsEn: ['bed sheet', 'duvet cover', 'pillowcase', 'towel', 'blanket', 'quilt', 'bedding set', 'mattress protector'],
    keywordsRo: ['lenjerie de pat', 'lenjerii pat', 'fata perna', 'prosop', 'prosoape', 'patura', 'cuvertura', 'set lenjerie'],
    keywordsZh: ['床单', '被套', '枕套', '毛巾', '毯子', '棉被', '床品套装', '床垫保护套'],
  },
  {
    rate: 0.18,
    label: '监控安防',
    keywordsEn: ['surveillance camera', 'security camera', 'cctv', 'ip camera', 'alarm system', 'doorbell camera', 'motion sensor'],
    keywordsRo: ['camera supraveghere', 'camere supraveghere', 'cctv', 'camera ip', 'sistem alarma', 'alarma', 'camera sonerie', 'senzor miscare'],
    keywordsZh: ['监控摄像头', '安防摄像头', 'CCTV', '网络摄像头', '报警系统', '门铃摄像头', '运动感应器'],
  },

  // ══════════════════════════════════════════════════════════
  // 19%
  // ══════════════════════════════════════════════════════════
  {
    rate: 0.19,
    label: '风扇与冷风机',
    keywordsEn: ['tower fan', 'pedestal fan', 'desk fan', 'ceiling fan', 'air cooler', 'portable air cooler', 'evaporative cooler'],
    keywordsRo: ['ventilator', 'ventilatoare', 'ventilator turn', 'ventilator birou', 'racitor aer portabil', 'racitor evaporativ'],
    keywordsZh: ['电风扇', '塔扇', '落地扇', '台扇', '吊扇', '冷风机', '蒸发式冷风机'],
  },

  // ══════════════════════════════════════════════════════════
  // 20%
  // ══════════════════════════════════════════════════════════
  {
    rate: 0.20,
    label: '成人情趣用品',
    keywordsEn: ['erotic toy', 'sex toy', 'adult toy', 'adult game', 'erotic lingerie'],
    keywordsRo: ['jucarie erotica', 'jucarii erotice', 'joc erotic', 'lenjerie erotica'],
    keywordsZh: ['成人玩具', '情趣用品', '情趣内衣'],
  },
  {
    rate: 0.20,
    label: '汽车轮毂盖防滑链',
    keywordsEn: ['hubcap', 'wheel cover', 'snow chain', 'wheel cap', 'tire chain'],
    keywordsRo: ['capac roata', 'capace roti', 'lant zapada', 'lanturi zapada', 'lant antiderapant'],
    keywordsZh: ['轮毂盖', '防滑链', '雪地链'],
  },
  {
    rate: 0.20,
    label: '医疗康复矫形器',
    keywordsEn: ['orthopedic support', 'knee brace', 'back brace', 'ankle support', 'wrist brace', 'lumbar support', 'orthopaedic'],
    keywordsRo: ['suport ortopedic', 'suporturi ortopedice', 'orteza genunchi', 'genunchiera', 'lombostata', 'orteza glezna'],
    keywordsZh: ['矫形器', '护膝', '腰托', '踝关节护具', '腕关节护具', '腰部支撑'],
  },

  // ══════════════════════════════════════════════════════════
  // 21%
  // ══════════════════════════════════════════════════════════
  {
    rate: 0.21,
    label: '手机壳保护套',
    keywordsEn: ['phone case', 'phone cover', 'mobile case', 'smartphone case', 'phone back cover', 'tempered glass phone', 'screen protector phone'],
    keywordsRo: ['husa telefon', 'huse telefoane', 'carcasa telefon', 'carcase telefoane', 'folie sticla telefon', 'protectie ecran telefon'],
    keywordsZh: ['手机壳', '手机保护套', '手机背壳', '手机钢化膜', '手机贴膜'],
  },
  {
    rate: 0.21,
    label: 'IT外设键鼠摄像头U盘',
    keywordsEn: ['keyboard', 'mechanical keyboard', 'computer mouse', 'wireless mouse', 'webcam', 'usb stick', 'usb flash drive', 'gaming mouse'],
    keywordsRo: ['tastatura', 'tastaturi', 'tastatura mecanica', 'mouse', 'mouse wireless', 'webcam', 'stick usb', 'memorie usb'],
    keywordsZh: ['键盘', '机械键盘', '鼠标', '无线鼠标', '摄像头', 'U盘', 'USB闪存', '游戏鼠标'],
  },
  {
    rate: 0.21,
    label: '电池与充电器通用',
    keywordsEn: ['aa battery', 'aaa battery', 'rechargeable battery', 'lithium battery', 'charger cable', 'usb charger', 'wall charger', 'power bank'],
    keywordsRo: ['baterie aa', 'baterie aaa', 'baterie reincarcabila', 'baterie litiu', 'cablu incarcare', 'incarcator usb', 'incarcator priza', 'baterie externa'],
    keywordsZh: ['电池', '充电电池', '锂电池', '充电线', 'USB充电器', '插头充电器', '充电宝'],
  },
  {
    rate: 0.21,
    label: '厨具餐具锅杯刀',
    keywordsEn: ['cooking pot', 'frying pan', 'wok', 'kitchen knife', 'knife set', 'glass set', 'mug', 'plate', 'bowl', 'cutlery'],
    keywordsRo: ['oala', 'oale', 'tigaie', 'tigai', 'cutit', 'cuțite', 'set pahare', 'cana', 'farfurie', 'bol', 'tacamuri'],
    keywordsZh: ['锅', '炒锅', '平底锅', '厨刀', '刀具套装', '玻璃杯', '马克杯', '碗', '盘子', '餐具'],
  },
  {
    rate: 0.21,
    label: '宠物用品笼玩具绳',
    keywordsEn: ['pet cage', 'cat carrier', 'dog carrier', 'pet toy', 'dog leash', 'cat leash', 'pet collar', 'aquarium', 'fish tank'],
    keywordsRo: ['cusca animale', 'cusca pisica', 'cusca caine', 'jucarie animale', 'lesa caine', 'zgarda', 'acvariu', 'custi'],
    keywordsZh: ['宠物笼', '猫笼', '狗笼', '宠物玩具', '狗绳', '猫绳', '宠物项圈', '鱼缸', '水族箱'],
  },
  {
    rate: 0.21,
    label: '照明灯泡灯具',
    keywordsEn: ['light bulb', 'led bulb', 'ceiling light', 'wall light', 'floor lamp', 'table lamp', 'strip light', 'smart bulb'],
    keywordsRo: ['bec', 'becuri', 'bec led', 'plafoniera', 'aplica', 'lampa de podea', 'veioza', 'banda led', 'bec smart'],
    keywordsZh: ['灯泡', 'LED灯泡', '吸顶灯', '壁灯', '落地灯', '台灯', 'LED灯带', '智能灯泡'],
  },
  {
    rate: 0.21,
    label: '文具笔本画材',
    keywordsEn: ['ballpoint pen', 'fountain pen', 'notebook', 'sketchbook', 'painting set', 'colored pencil', 'marker pen', 'art supply'],
    keywordsRo: ['pix', 'stilou', 'caiet', 'carnet', 'set pictura', 'creioane colorate', 'marker', 'consumabile scris'],
    keywordsZh: ['圆珠笔', '钢笔', '笔记本', '素描本', '绘画套装', '彩色铅笔', '马克笔', '美术用品'],
  },
  {
    rate: 0.21,
    label: '园艺花盆软管',
    keywordsEn: ['flower pot', 'garden pot', 'garden hose', 'planter box', 'garden tool', 'potting soil'],
    keywordsRo: ['ghiveci', 'ghivece', 'furtun gradina', 'furtunuri', 'jardiniera', 'pamant flori'],
    keywordsZh: ['花盆', '花槽', '园艺软管', '花箱', '园艺工具', '花土'],
  },
  {
    rate: 0.21,
    label: '智能家居配件传感器',
    keywordsEn: ['smart home sensor', 'smart plug', 'smart bulb socket', 'smart home hub', 'zigbee', 'matter device', 'smart switch'],
    keywordsRo: ['senzor smart home', 'senzori smart home', 'priza smart', 'hub smart home', 'intrerupator smart'],
    keywordsZh: ['智能家居传感器', '智能插座', '智能家居中枢', 'Zigbee设备', '智能开关'],
  },

  // ══════════════════════════════════════════════════════════
  // 22%
  // ══════════════════════════════════════════════════════════
  {
    rate: 0.22,
    label: '汽车美容清洁香水',
    keywordsEn: ['car wax', 'car polish', 'car wash', 'car shampoo', 'car freshener', 'car perfume', 'car cleaning fluid', 'car cosmetics'],
    keywordsRo: ['ceara auto', 'polish auto', 'sampon auto', 'odorizant auto', 'cosmetica auto', 'solutie curatare auto', 'odorizante auto'],
    keywordsZh: ['汽车蜡', '汽车抛光', '洗车液', '车载香水', '汽车清洁剂', '汽车美容'],
  },

  // ══════════════════════════════════════════════════════════
  // 23%
  // ══════════════════════════════════════════════════════════
  {
    rate: 0.23,
    label: '手机零件与组件',
    keywordsEn: ['phone part', 'phone component', 'phone motherboard', 'phone battery replacement', 'phone repair part'],
    keywordsRo: ['piesa telefon', 'piese telefoane', 'componenta telefon', 'placa baza telefon', 'baterie telefon inlocuire'],
    keywordsZh: ['手机零件', '手机配件维修', '手机主板', '手机电池更换', '手机维修零件'],
  },
  {
    rate: 0.23,
    label: '线缆与适配器',
    keywordsEn: ['hdmi cable', 'usb cable', 'audio cable', 'ethernet cable', 'adapter cable', 'charging cable', 'extension cord', 'cable management'],
    keywordsRo: ['cablu hdmi', 'cablu usb', 'cablu audio', 'cablu retea', 'adaptor cablu', 'cablu incarcare', 'prelungitor', 'cabluri', 'adaptoare'],
    keywordsZh: ['HDMI线', 'USB数据线', '音频线', '网线', '转接头', '充电线', '延长线', '线缆'],
  },
  {
    rate: 0.23,
    label: '相机包三脚架',
    keywordsEn: ['camera bag', 'camera case', 'tripod', 'monopod', 'camera strap', 'lens filter', 'camera stand'],
    keywordsRo: ['geanta foto', 'husa aparata foto', 'trepied', 'monopied', 'curea aparat foto', 'filtru obiectiv'],
    keywordsZh: ['相机包', '相机保护套', '三脚架', '单脚架', '相机背带', '镜头滤镜'],
  },
  {
    rate: 0.23,
    label: '办公文具订书机纸',
    keywordsEn: ['stapler', 'printer paper', 'calculator', 'paper folder', 'binder', 'sticky note', 'correction tape', 'office paper'],
    keywordsRo: ['capsator', 'hartie imprimanta', 'calculator birou', 'dosar', 'notes adeziv', 'banda corectoare', 'hartie copiator'],
    keywordsZh: ['订书机', '打印纸', '计算器', '文件夹', '便利贴', '修正带', '复印纸'],
  },
  {
    rate: 0.23,
    label: '节日装饰圣诞派对',
    keywordsEn: ['christmas decoration', 'christmas tree', 'party decoration', 'halloween', 'ornament', 'garland', 'party supply'],
    keywordsRo: ['decoratiune craciun', 'brad craciun', 'pom craciun', 'decoratiuni petrecere', 'halloween', 'ghirlanda', 'ornament'],
    keywordsZh: ['圣诞装饰', '圣诞树', '派对装饰', '万圣节', '节日挂饰', '花环'],
  },
  {
    rate: 0.23,
    label: '家居装饰画蜡烛',
    keywordsEn: ['wall painting', 'canvas art', 'candle', 'wallpaper', 'wall decal', 'photo frame', 'decorative vase'],
    keywordsRo: ['tablou', 'tablouri', 'lumanare', 'lumanari', 'tapet', 'autocolant perete', 'rama foto', 'vaza decorativa'],
    keywordsZh: ['装饰画', '油画', '蜡烛', '壁纸', '墙贴', '相框', '装饰花瓶'],
  },
  {
    rate: 0.23,
    label: '清洁工具扫把垃圾桶',
    keywordsEn: ['broom', 'mop', 'trash can', 'dustbin', 'dustpan', 'cleaning bucket', 'floor brush'],
    keywordsRo: ['matura', 'maturi', 'mop', 'cos gunoi', 'cosuri gunoi', 'furas', 'galeata curatenie', 'perie pardoseala'],
    keywordsZh: ['扫把', '拖把', '垃圾桶', '簸箕', '清洁桶', '地刷'],
  },
  {
    rate: 0.23,
    label: '配件大全各类通用',
    keywordsEn: ['accessory', 'spare parts', 'replacement part', 'universal adapter', 'generic accessory'],
    keywordsRo: ['accesoriu', 'accesorii diverse', 'piese schimb', 'piesa inlocuire', 'adaptor universal'],
    keywordsZh: ['配件', '通用配件', '零配件', '替换件', '万能适配器'],
  },
];

/**
 * 按费率从低到高排序（commissionMatcher 使用此顺序：第一个命中即返回最低率匹配）
 */
export const COMMISSION_RULES_SORTED = [...COMMISSION_RULES].sort((a, b) => a.rate - b.rate);

/**
 * 终极兜底佣金率（18%，大盘折中参考）
 * 严禁使用 0.23 兜底——会导致利润严重低估
 */
export const DEFAULT_COMMISSION_RATE = 0.18;
