"use strict";

/*
 * relay/voices.js —— 豆包语音合成模型 2.0 的可用音色清单（服务端唯一事实来源）
 *
 * ⚠⚠ **这个文件是自动生成的，不要手改** —— 手改会在下次生成时丢掉。
 *   改音色表请改"上游"：
 *     node scripts/make-voices.cjs            # 从 relay/voices.official.json 重新生成
 *     node scripts/make-voices.cjs --check    # 检查磁盘上这份是不是最新的
 *     node scripts/make-voices.cjs --parse <官方音色列表.md>   # 用新抓的官方正文刷新快照
 *
 * 数据来源：音色列表（豆包语音合成模型2.0 / S2S-O2.0 / S2S-全双工）
 *   https://www.volcengine.com/docs/6561/1257544
 *   抓取日期：2026-09-14
 *
 * 生成时做了什么（详见 scripts/make-voices.cjs）：
 *   · 只保留 `*_uranus_bigtts` —— 那是与 `seed-tts-2.0` 配套的一族。
 *     放别族进来上游会回 `55000000 资源标识与音色不匹配`
 *     （`*_mars_bigtts` / `*_moon_bigtts` 是 1.0，`saturn_*` / `S_*` 是声音复刻）；
 *   · 剔除官方表格里的残缺行（只有语言前缀、没有音色名）；
 *   · **剔除名人/影视角色音色**（见文件末尾 `LIKENESS_EXCLUDED`）—— 授权风险，不给用户用。
 *
 * ⚠ 两件必须记住的事：
 *   ① 官方这张表是**全目录**，不是你账号能用的那些 —— 没开通的音色上游会回
 *      `45000000 speaker permission denied`。最终以控制台「音色管理」里实际可用的为准；
 *   ② 这张表可以整体覆盖 / 追加，不用改代码：
 *        VOLC_TTS_SPEAKERS="id1=名字1,id2=名字2"     只认这几项
 *        VOLC_TTS_SPEAKERS_EXTRA="id3=名字3"         追加在默认表后面
 *      （买来的复刻/设计音色 `S_*` 就用 EXTRA 加 —— 但它要配 `seed-icl-2.0`，
 *        见 docs/VOICE_CLOUD_TTS.md §10.5，不是随便加进来就能用。）
 */

/** 默认音色：官方示例自己用的就是 vivi 2.0。 */
const DEFAULT_SPEAKER = "zh_female_vv_uranus_bigtts";

/** 2.0 这一族的 id 形状（seed-tts-2.0 只认 \`*_uranus_bigtts\`）—— 测试与校验都用它。 */
const ID_RE = /^[a-z]{2}(?:_[a-z]{2})?_[a-z0-9_]+_uranus_bigtts$/;

const SPEAKERS_ZH = [
  {"id":"zh_male_aojiaobazong_uranus_bigtts","label":"傲娇霸总 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"male","scene":"通用"},
  {"id":"zh_male_baqiqingshu_uranus_bigtts","label":"霸气青叔 2.0 · 有声阅读","lang":"zh","langLabel":"中文","gender":"male","scene":"有声阅读"},
  {"id":"zh_female_chanmeinv_uranus_bigtts","label":"谄媚女声 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"female","scene":"通用"},
  {"id":"zh_female_chunribu_uranus_bigtts","label":"春日部姐姐 2.0 · 角色扮演","lang":"zh","langLabel":"中文","gender":"female","scene":"角色扮演"},
  {"id":"zh_male_cixingjieshuonan_uranus_bigtts","label":"磁性解说男声 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"male","scene":"通用"},
  {"id":"zh_male_dayi_uranus_bigtts","label":"大壹 2.0 · 视频配音","lang":"zh","langLabel":"中文","gender":"male","scene":"视频配音"},
  {"id":"zh_male_dongfanghaoran_uranus_bigtts","label":"东方浩然 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"male","scene":"通用"},
  {"id":"zh_female_xiaoxue_uranus_bigtts","label":"儿童绘本 2.0 · 有声阅读","lang":"zh","langLabel":"中文","gender":"female","scene":"有声阅读"},
  {"id":"zh_male_fanjuanqingnian_uranus_bigtts","label":"反卷青年 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"male","scene":"通用"},
  {"id":"zh_female_ganmaodianyin_uranus_bigtts","label":"感冒电音姐姐 2.0 · 角色扮演","lang":"zh","langLabel":"中文","gender":"female","scene":"角色扮演"},
  {"id":"zh_male_gaolengchenwen_uranus_bigtts","label":"高冷沉稳 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"male","scene":"通用"},
  {"id":"zh_female_gaolengyujie_uranus_bigtts","label":"高冷御姐 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"female","scene":"通用"},
  {"id":"zh_female_gufengshaoyu_uranus_bigtts","label":"古风少御 2.0 · 角色扮演","lang":"zh","langLabel":"中文","gender":"female","scene":"角色扮演"},
  {"id":"zh_female_gujie_uranus_bigtts","label":"顾姐 2.0 · 角色扮演","lang":"zh","langLabel":"中文","gender":"female","scene":"角色扮演"},
  {"id":"zh_male_guanggaojieshuo_uranus_bigtts","label":"广告解说 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"male","scene":"通用"},
  {"id":"zh_female_mizai_uranus_bigtts","label":"黑猫侦探社咪仔 2.0 · 视频配音","lang":"zh","langLabel":"中文","gender":"female","scene":"视频配音"},
  {"id":"zh_male_sunwukong_uranus_bigtts","label":"猴哥 2.0 · 视频配音","lang":"zh","langLabel":"中文","gender":"male","scene":"视频配音"},
  {"id":"zh_male_huolixiaoge_uranus_bigtts","label":"活力小哥 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"male","scene":"通用"},
  {"id":"zh_female_jitangmei_uranus_bigtts","label":"鸡汤妹妹 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"female","scene":"通用"},
  {"id":"zh_female_jitangnv_uranus_bigtts","label":"鸡汤女 2.0 · 视频配音","lang":"zh","langLabel":"中文","gender":"female","scene":"视频配音"},
  {"id":"zh_female_jiaochuannv_uranus_bigtts","label":"娇喘女声 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"female","scene":"通用"},
  {"id":"zh_male_jieshuoxiaoming_uranus_bigtts","label":"解说小明 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"male","scene":"通用"},
  {"id":"zh_male_kailangdidi_uranus_bigtts","label":"开朗弟弟 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"male","scene":"通用"},
  {"id":"zh_female_kailangjiejie_uranus_bigtts","label":"开朗姐姐 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"female","scene":"通用"},
  {"id":"zh_male_kailangxuezhang_uranus_bigtts","label":"开朗学长 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"male","scene":"通用"},
  {"id":"zh_male_kuailexiaodong_uranus_bigtts","label":"快乐小东 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"male","scene":"通用"},
  {"id":"zh_male_lanyinmianbao_uranus_bigtts","label":"懒音绵宝 2.0 · 角色扮演","lang":"zh","langLabel":"中文","gender":"male","scene":"角色扮演"},
  {"id":"zh_male_liangsangmengzai_uranus_bigtts","label":"亮嗓萌仔 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"male","scene":"通用"},
  {"id":"zh_male_linjiananhai_uranus_bigtts","label":"邻家男孩 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"male","scene":"通用"},
  {"id":"zh_female_linjianvhai_uranus_bigtts","label":"邻家女孩 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"female","scene":"通用"},
  {"id":"zh_female_linxiao_uranus_bigtts","label":"林潇 2.0 · 角色扮演","lang":"zh","langLabel":"中文","gender":"female","scene":"角色扮演"},
  {"id":"zh_female_lingling_uranus_bigtts","label":"玲玲姐姐 2.0 · 角色扮演","lang":"zh","langLabel":"中文","gender":"female","scene":"角色扮演"},
  {"id":"zh_male_liufei_uranus_bigtts","label":"刘飞 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"male","scene":"通用"},
  {"id":"zh_female_liuchangnv_uranus_bigtts","label":"流畅女声 2.0 · 视频配音","lang":"zh","langLabel":"中文","gender":"female","scene":"视频配音"},
  {"id":"zh_male_lubanqihao_uranus_bigtts","label":"鲁班七号 2.0 · 角色扮演","lang":"zh","langLabel":"中文","gender":"male","scene":"角色扮演"},
  {"id":"zh_female_meilinvyou_uranus_bigtts","label":"魅力女友 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"female","scene":"通用"},
  {"id":"zh_female_sophie_uranus_bigtts","label":"魅力苏菲 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"female","scene":"通用"},
  {"id":"zh_female_mengyatou_uranus_bigtts","label":"萌丫头 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"female","scene":"通用"},
  {"id":"zh_male_naiqimengwa_uranus_bigtts","label":"奶气萌娃 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"male","scene":"通用"},
  {"id":"zh_female_nvleishen_uranus_bigtts","label":"女雷神 2.0 · 角色扮演","lang":"zh","langLabel":"中文","gender":"female","scene":"角色扮演"},
  {"id":"zh_female_kefunvsheng_uranus_bigtts","label":"暖阳女声 2.0 · 客服","lang":"zh","langLabel":"中文","gender":"female","scene":"客服"},
  {"id":"zh_female_peiqi_uranus_bigtts","label":"佩奇猪 2.0 · 视频配音","lang":"zh","langLabel":"中文","gender":"female","scene":"视频配音"},
  {"id":"zh_female_popo_uranus_bigtts","label":"婆婆 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"female","scene":"通用"},
  {"id":"zh_female_qiaopinv_uranus_bigtts","label":"俏皮女声 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"female","scene":"通用"},
  {"id":"zh_female_qinqienv_uranus_bigtts","label":"亲切女声 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"female","scene":"通用"},
  {"id":"zh_female_qingchezizi_uranus_bigtts","label":"清澈梓梓 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"female","scene":"通用"},
  {"id":"zh_male_qingshuangnanda_uranus_bigtts","label":"清爽男大 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"male","scene":"通用"},
  {"id":"zh_female_qingxinnvsheng_uranus_bigtts","label":"清新女声 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"female","scene":"通用"},
  {"id":"zh_male_qingcang_uranus_bigtts","label":"擎苍 2.0 · 角色扮演","lang":"zh","langLabel":"中文","gender":"male","scene":"角色扮演"},
  {"id":"zh_female_roumeinvyou_uranus_bigtts","label":"柔美女友 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"female","scene":"通用"},
  {"id":"zh_male_ruyaqingnian_uranus_bigtts","label":"儒雅青年 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"male","scene":"通用"},
  {"id":"zh_male_ruyayichen_uranus_bigtts","label":"儒雅逸辰 2.0 · 视频配音","lang":"zh","langLabel":"中文","gender":"male","scene":"视频配音"},
  {"id":"zh_female_sajiaoxuemei_uranus_bigtts","label":"撒娇学妹 2.0 · 角色扮演","lang":"zh","langLabel":"中文","gender":"female","scene":"角色扮演"},
  {"id":"zh_female_shaoergushi_uranus_bigtts","label":"少儿故事 2.0 · 有声阅读","lang":"zh","langLabel":"中文","gender":"female","scene":"有声阅读"},
  {"id":"zh_male_shaonianzixin_uranus_bigtts","label":"少年梓辛 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"male","scene":"通用"},
  {"id":"zh_male_shenyeboke_uranus_bigtts","label":"深夜播客 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"male","scene":"通用"},
  {"id":"zh_female_shuangkuaisisi_uranus_bigtts","label":"爽快思思 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"female","scene":"通用"},
  {"id":"zh_male_silang_uranus_bigtts","label":"四郎 2.0 · 角色扮演","lang":"zh","langLabel":"中文","gender":"male","scene":"角色扮演"},
  {"id":"zh_male_tangseng_uranus_bigtts","label":"唐僧 2.0 · 角色扮演","lang":"zh","langLabel":"中文","gender":"male","scene":"角色扮演"},
  {"id":"zh_male_tiancaitongsheng_uranus_bigtts","label":"天才童声 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"male","scene":"通用"},
  {"id":"zh_female_tianmeitaozi_uranus_bigtts","label":"甜美桃子 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"female","scene":"通用"},
  {"id":"zh_female_tianmeixiaoyuan_uranus_bigtts","label":"甜美小源 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"female","scene":"通用"},
  {"id":"zh_female_tianmeiyueyue_uranus_bigtts","label":"甜美悦悦 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"female","scene":"通用"},
  {"id":"zh_female_tiexinnvsheng_uranus_bigtts","label":"贴心女声 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"female","scene":"通用"},
  {"id":"zh_male_wennuanahu_uranus_bigtts","label":"温暖阿虎 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"male","scene":"通用"},
  {"id":"zh_female_wenroumama_uranus_bigtts","label":"温柔妈妈 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"female","scene":"通用"},
  {"id":"zh_female_wenroushunv_uranus_bigtts","label":"温柔淑女 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"female","scene":"通用"},
  {"id":"zh_male_wenrouxiaoge_uranus_bigtts","label":"温柔小哥 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"male","scene":"通用"},
  {"id":"zh_female_wenrouxiaoya_uranus_bigtts","label":"温柔小雅 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"female","scene":"通用"},
  {"id":"zh_female_wenjingmaomao_uranus_bigtts","label":"文静毛毛 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"female","scene":"通用"},
  {"id":"zh_female_wuzetian_uranus_bigtts","label":"武则天 2.0 · 角色扮演","lang":"zh","langLabel":"中文","gender":"female","scene":"角色扮演"},
  {"id":"zh_female_xiaohe_uranus_bigtts","label":"小何 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"female","scene":"通用"},
  {"id":"zh_male_taocheng_uranus_bigtts","label":"小天 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"male","scene":"通用"},
  {"id":"zh_female_xinlingjitang_uranus_bigtts","label":"心灵鸡汤 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"female","scene":"通用"},
  {"id":"zh_male_xionger_uranus_bigtts","label":"熊二 2.0 · 角色扮演","lang":"zh","langLabel":"中文","gender":"male","scene":"角色扮演"},
  {"id":"zh_male_xuanyijieshuo_uranus_bigtts","label":"悬疑解说 2.0 · 有声阅读","lang":"zh","langLabel":"中文","gender":"male","scene":"有声阅读"},
  {"id":"zh_male_yangguangqingnian_uranus_bigtts","label":"阳光青年 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"male","scene":"通用"},
  {"id":"zh_male_yizhipiannan_uranus_bigtts","label":"译制片男 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"male","scene":"通用"},
  {"id":"zh_female_yingtaowanzi_uranus_bigtts","label":"樱桃丸子 2.0 · 角色扮演","lang":"zh","langLabel":"中文","gender":"female","scene":"角色扮演"},
  {"id":"zh_male_youyoujunzi_uranus_bigtts","label":"悠悠君子 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"male","scene":"通用"},
  {"id":"zh_male_yuanboxiaoshu_uranus_bigtts","label":"渊博小叔 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"male","scene":"通用"},
  {"id":"zh_male_m191_uranus_bigtts","label":"云舟 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"male","scene":"通用"},
  {"id":"zh_female_cancan_uranus_bigtts","label":"知性灿灿 2.0 · 角色扮演","lang":"zh","langLabel":"中文","gender":"female","scene":"角色扮演"},
  {"id":"zh_female_zhixingnv_uranus_bigtts","label":"知性女声 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"female","scene":"通用"},
  {"id":"zh_female_zhishuaiyingzi_uranus_bigtts","label":"直率英子 2.0 · 角色扮演","lang":"zh","langLabel":"中文","gender":"female","scene":"角色扮演"},
  {"id":"zh_male_zhubajie_uranus_bigtts","label":"猪八戒 2.0 · 角色扮演","lang":"zh","langLabel":"中文","gender":"male","scene":"角色扮演"},
  {"id":"zh_male_zhuangzhou_uranus_bigtts","label":"庄周 2.0 · 角色扮演","lang":"zh","langLabel":"中文","gender":"male","scene":"角色扮演"},
  {"id":"zh_female_yingyujiaoxue_uranus_bigtts","label":"Tina老师 2.0 · 教育","lang":"zh","langLabel":"中文","gender":"female","scene":"教育"},
  {"id":"zh_female_tvbnv_uranus_bigtts","label":"TVB女声 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"female","scene":"通用"},
  {"id":"zh_female_vv_uranus_bigtts","label":"Vivi 2.0 · 通用","lang":"zh","langLabel":"中文","gender":"female","scene":"通用"},
];

const SPEAKERS_EN = [
  {"id":"en_male_bruce_uranus_bigtts","label":"Adrian · 通用","lang":"en","langLabel":"英语","gender":"male","scene":"通用"},
  {"id":"en_male_alberto_uranus_bigtts","label":"Alberto · 通用","lang":"en","langLabel":"英语","gender":"male","scene":"通用"},
  {"id":"en_male_alex_uranus_bigtts","label":"Alex · 通用","lang":"en","langLabel":"英语","gender":"male","scene":"通用"},
  {"id":"en_female_allison_uranus_bigtts","label":"Allison · 视频配音","lang":"en","langLabel":"英语","gender":"female","scene":"视频配音"},
  {"id":"en_male_hades_uranus_bigtts","label":"Beau · 通用","lang":"en","langLabel":"英语","gender":"male","scene":"通用"},
  {"id":"en_male_bill_jones_corey_uranus_bigtts","label":"Bill · 通用","lang":"en","langLabel":"英语","gender":"male","scene":"通用"},
  {"id":"en_female_nadia_uranus_bigtts","label":"Blair · 通用","lang":"en","langLabel":"英语","gender":"female","scene":"通用"},
  {"id":"en_male_jidongchuanjiaoshi_uranus_bigtts","label":"Blaze · 趣味口音","lang":"en","langLabel":"英语","gender":"male","scene":"趣味口音"},
  {"id":"en_female_brittney_uranus_bigtts","label":"Brittney · 通用","lang":"en","langLabel":"英语","gender":"female","scene":"通用"},
  {"id":"en_male_valentino_corey_uranus_bigtts","label":"Clark · 视频配音","lang":"en","langLabel":"英语","gender":"male","scene":"视频配音"},
  {"id":"en_female_dacey_uranus_bigtts","label":"Dacey · 外语音色","lang":"en","langLabel":"英语","gender":"female","scene":"外语音色"},
  {"id":"en_male_david_uranus_bigtts","label":"David · 通用","lang":"en","langLabel":"英语","gender":"male","scene":"通用"},
  {"id":"en_male_yangguangjieshuonan_uranus_bigtts","label":"Dylan · 通用","lang":"en","langLabel":"英语","gender":"male","scene":"通用"},
  {"id":"en_male_michael_uranus_bigtts","label":"Hank · 通用","lang":"en","langLabel":"英语","gender":"male","scene":"通用"},
  {"id":"en_female_hayley_uranus_bigtts","label":"Hayley · 教学","lang":"en","langLabel":"英语","gender":"female","scene":"教学"},
  {"id":"en_male_jamie_uranus_bigtts","label":"Jamie · 通用","lang":"en","langLabel":"英语","gender":"male","scene":"通用"},
  {"id":"en_female_jane_uranus_bigtts","label":"Jane · 视频配音","lang":"en","langLabel":"英语","gender":"female","scene":"视频配音"},
  {"id":"en_female_jenny_uranus_bigtts","label":"Jenny · 通用","lang":"en","langLabel":"英语","gender":"female","scene":"通用"},
  {"id":"en_male_jimmy_uranus_bigtts","label":"Jimmy · 通用","lang":"en","langLabel":"英语","gender":"male","scene":"通用"},
  {"id":"en_female_joanne_uranus_bigtts","label":"Joanne · 通用","lang":"en","langLabel":"英语","gender":"female","scene":"通用"},
  {"id":"en_male_cowboy_john_b_uranus_bigtts","label":"John · 趣味口音","lang":"en","langLabel":"英语","gender":"male","scene":"趣味口音"},
  {"id":"en_male_josh_uranus_bigtts","label":"Josh · 视频配音","lang":"en","langLabel":"英语","gender":"male","scene":"视频配音"},
  {"id":"en_male_josh_coery_uranus_bigtts","label":"Josiah · 教学","lang":"en","langLabel":"英语","gender":"male","scene":"教学"},
  {"id":"en_male_diyuwenrounan_uranus_bigtts","label":"Julian · 有声阅读","lang":"en","langLabel":"英语","gender":"male","scene":"有声阅读"},
  {"id":"en_female_xinwenjieshuonv_uranus_bigtts","label":"Kayla · 角色扮演","lang":"en","langLabel":"英语","gender":"female","scene":"角色扮演"},
  {"id":"en_male_kevin_uranus_bigtts","label":"Kevin · 教学","lang":"en","langLabel":"英语","gender":"male","scene":"教学"},
  {"id":"en_male_knightley_uranus_bigtts","label":"Knightley · 有声阅读","lang":"en","langLabel":"英语","gender":"male","scene":"有声阅读"},
  {"id":"en_male_marcus_uranus_bigtts","label":"Marcus · 通用","lang":"en","langLabel":"英语","gender":"male","scene":"通用"},
  {"id":"en_female_wenrouzhishijieshuonv_uranus_bigtts","label":"Megan · 客服","lang":"en","langLabel":"英语","gender":"female","scene":"客服"},
  {"id":"en_female_mel_uranus_bigtts","label":"Mel · 教学","lang":"en","langLabel":"英语","gender":"female","scene":"教学"},
  {"id":"en_male_michael_kevin_uranus_bigtts","label":"Michael_Kevin · 通用","lang":"en","langLabel":"英语","gender":"male","scene":"通用"},
  {"id":"en_female_myra_uranus_bigtts","label":"Myra · 教学","lang":"en","langLabel":"英语","gender":"female","scene":"教学"},
  {"id":"en_female_natasha_uranus_bigtts","label":"Natasha · 通用","lang":"en","langLabel":"英语","gender":"female","scene":"通用"},
  {"id":"en_male_ronald_uranus_bigtts","label":"Ronald · 有声阅读","lang":"en","langLabel":"英语","gender":"male","scene":"有声阅读"},
  {"id":"en_male_russell_uranus_bigtts","label":"Russell · 通用","lang":"en","langLabel":"英语","gender":"male","scene":"通用"},
  {"id":"en_female_sharron_uranus_bigtts","label":"Sharron · 趣味口音","lang":"en","langLabel":"英语","gender":"female","scene":"趣味口音"},
  {"id":"en_female_skye_uranus_bigtts","label":"Skye · 通用","lang":"en","langLabel":"英语","gender":"female","scene":"通用"},
  {"id":"en_female_stokie_uranus_bigtts","label":"Stokie · 外语音色","lang":"en","langLabel":"英语","gender":"female","scene":"外语音色"},
  {"id":"en_female_myra_cmb_uranus_bigtts","label":"Sunny · 教学","lang":"en","langLabel":"英语","gender":"female","scene":"教学"},
  {"id":"en_male_tim_uranus_bigtts","label":"Tim · 外语音色","lang":"en","langLabel":"英语","gender":"male","scene":"外语音色"},
  {"id":"en_male_valentino_uranus_bigtts","label":"Valentino · 通用","lang":"en","langLabel":"英语","gender":"male","scene":"通用"},
  {"id":"en_female_brittney_pimintel_uranus_bigtts","label":"Zoe · 有声阅读","lang":"en","langLabel":"英语","gender":"female","scene":"有声阅读"},
];

/** 其它语言（日/韩/西/葡/俄/印尼/越南/泰/法/德/阿…）。中文角色用不上，但列表里留着。 */
const SPEAKERS_OTHER = [
  {"id":"ru_female_af07_uranus_bigtts","label":"Amelia · 有声阅读","lang":"other","langLabel":"其他语言","gender":"female","scene":"有声阅读"},
  {"id":"tl_female_annika_uranus_bigtts","label":"Annika · 通用","lang":"other","langLabel":"其他语言","gender":"female","scene":"通用"},
  {"id":"ja_female_bv521_uranus_bigtts","label":"Aoi · 趣味口音","lang":"other","langLabel":"其他语言","gender":"female","scene":"趣味口音"},
  {"id":"pt_male_bv531_uranus_bigtts","label":"Arthur · 通用","lang":"other","langLabel":"其他语言","gender":"male","scene":"通用"},
  {"id":"ja_female_bv024_uranus_bigtts","label":"Bonnie · 通用","lang":"other","langLabel":"其他语言","gender":"female","scene":"通用"},
  {"id":"fr_female_fr_f47_uranus_bigtts","label":"Camille · 教学","lang":"other","langLabel":"其他语言","gender":"female","scene":"教学"},
  {"id":"id_female_bv161narration_uranus_bigtts","label":"Celeste · 通用","lang":"other","langLabel":"其他语言","gender":"female","scene":"通用"},
  {"id":"id_female_f20_uranus_bigtts","label":"Chloe · 视频配音","lang":"other","langLabel":"其他语言","gender":"female","scene":"视频配音"},
  {"id":"id_female_bv161_uranus_bigtts","label":"Clara · 通用","lang":"other","langLabel":"其他语言","gender":"female","scene":"通用"},
  {"id":"id_female_bv164_uranus_bigtts","label":"Crew · 通用","lang":"other","langLabel":"其他语言","gender":"female","scene":"通用"},
  {"id":"es_male_dani_uranus_bigtts","label":"Dani · 有声阅读","lang":"other","langLabel":"其他语言","gender":"male","scene":"有声阅读"},
  {"id":"mx_male_ht_mx_m012_uranus_bigtts","label":"Derek · 教学","lang":"other","langLabel":"其他语言","gender":"male","scene":"教学"},
  {"id":"pt_female_bv173_uranus_bigtts","label":"Diana · 通用","lang":"other","langLabel":"其他语言","gender":"female","scene":"通用"},
  {"id":"mx_male_bv165dialogue_uranus_bigtts","label":"Diego · 有声阅读","lang":"other","langLabel":"其他语言","gender":"male","scene":"有声阅读"},
  {"id":"ar_female_dina_uranus_bigtts","label":"Dina · 通用","lang":"other","langLabel":"其他语言","gender":"female","scene":"通用"},
  {"id":"tl_male_ed_uranus_bigtts","label":"Ed · 通用","lang":"other","langLabel":"其他语言","gender":"male","scene":"通用"},
  {"id":"pt_female_bv173dialogue_uranus_bigtts","label":"Elena · 视频配音","lang":"other","langLabel":"其他语言","gender":"female","scene":"视频配音"},
  {"id":"id_male_bv164dialogue_uranus_bigtts","label":"Elian · 视频配音","lang":"other","langLabel":"其他语言","gender":"male","scene":"视频配音"},
  {"id":"pt_female_bv173narrator_uranus_bigtts","label":"Emma · 视频配音","lang":"other","langLabel":"其他语言","gender":"female","scene":"视频配音"},
  {"id":"it_male_enzo_uranus_bigtts","label":"Enzo · 通用","lang":"other","langLabel":"其他语言","gender":"male","scene":"通用"},
  {"id":"ar_female_fatma_uranus_bigtts","label":"Fatma · 趣味口音","lang":"other","langLabel":"其他语言","gender":"female","scene":"趣味口音"},
  {"id":"mx_male_felipe_uranus_bigtts","label":"Felipe · 通用","lang":"other","langLabel":"其他语言","gender":"male","scene":"通用"},
  {"id":"mx_female_bv166narrator_uranus_bigtts","label":"Freya · 有声阅读","lang":"other","langLabel":"其他语言","gender":"female","scene":"有声阅读"},
  {"id":"es_female_bv084_uranus_bigtts","label":"Gracie · 通用","lang":"other","langLabel":"其他语言","gender":"female","scene":"通用"},
  {"id":"es_male_guillem_uranus_bigtts","label":"Guillem · 有声阅读","lang":"other","langLabel":"其他语言","gender":"male","scene":"有声阅读"},
  {"id":"ms_male_ham_uranus_bigtts","label":"Ham · 通用","lang":"other","langLabel":"其他语言","gender":"male","scene":"通用"},
  {"id":"id_male_han_uranus_bigtts","label":"Han · 通用","lang":"other","langLabel":"其他语言","gender":"male","scene":"通用"},
  {"id":"ja_female_bv522_uranus_bigtts","label":"Hana · 通用","lang":"other","langLabel":"其他语言","gender":"female","scene":"通用"},
  {"id":"tl_female_hervie_uranus_bigtts","label":"Hervie · 有声阅读","lang":"other","langLabel":"其他语言","gender":"female","scene":"有声阅读"},
  {"id":"vi_female_hong_uranus_bigtts","label":"Hong · 通用","lang":"other","langLabel":"其他语言","gender":"female","scene":"通用"},
  {"id":"id_male_bv160narration_uranus_bigtts","label":"Hugo · 有声阅读","lang":"other","langLabel":"其他语言","gender":"male","scene":"有声阅读"},
  {"id":"mx_female_bv065_uranus_bigtts","label":"Irene · 教学","lang":"other","langLabel":"其他语言","gender":"female","scene":"教学"},
  {"id":"ru_female_irinae_uranus_bigtts","label":"Irinae · 有声阅读","lang":"other","langLabel":"其他语言","gender":"female","scene":"有声阅读"},
  {"id":"th_female_bv568_fear_uranus_bigtts","label":"Iris · 有声阅读","lang":"other","langLabel":"其他语言","gender":"female","scene":"有声阅读"},
  {"id":"ko_male_bv545_uranus_bigtts","label":"Jay · 通用","lang":"other","langLabel":"其他语言","gender":"male","scene":"通用"},
  {"id":"id_male_bv160dialogue_uranus_bigtts","label":"Jude · 通用","lang":"other","langLabel":"其他语言","gender":"male","scene":"通用"},
  {"id":"ja_male_bv524_uranus_bigtts","label":"Ken · 通用","lang":"other","langLabel":"其他语言","gender":"male","scene":"通用"},
  {"id":"ru_female_sophie_uranus_bigtts","label":"Ksenia · 通用","lang":"other","langLabel":"其他语言","gender":"female","scene":"通用"},
  {"id":"id_male_m08_uranus_bigtts","label":"Kyle · 通用","lang":"other","langLabel":"其他语言","gender":"male","scene":"通用"},
  {"id":"mx_female_leslie_uranus_bigtts","label":"Leslie · 通用","lang":"other","langLabel":"其他语言","gender":"female","scene":"通用"},
  {"id":"ja_female_bv523_uranus_bigtts","label":"Lily · 趣味口音","lang":"other","langLabel":"其他语言","gender":"female","scene":"趣味口音"},
  {"id":"vi_female_ling_uranus_bigtts","label":"Ling · 通用","lang":"other","langLabel":"其他语言","gender":"female","scene":"通用"},
  {"id":"vi_female_linh_uranus_bigtts","label":"Linh · 视频配音","lang":"other","langLabel":"其他语言","gender":"female","scene":"视频配音"},
  {"id":"pt_female_bv173emotion_uranus_bigtts","label":"Lola · 通用","lang":"other","langLabel":"其他语言","gender":"female","scene":"通用"},
  {"id":"mx_female_bv166dialogue_uranus_bigtts","label":"Lucy · 通用","lang":"other","langLabel":"其他语言","gender":"female","scene":"通用"},
  {"id":"th_female_bv568_sad_uranus_bigtts","label":"Lydia · 视频配音","lang":"other","langLabel":"其他语言","gender":"female","scene":"视频配音"},
  {"id":"mx_male_marcelo_uranus_bigtts","label":"Marcelo · 通用","lang":"other","langLabel":"其他语言","gender":"male","scene":"通用"},
  {"id":"mx_male_bv165narrator_uranus_bigtts","label":"Marcos · 有声阅读","lang":"other","langLabel":"其他语言","gender":"male","scene":"有声阅读"},
  {"id":"pt_female_mari_uranus_bigtts","label":"Mari · 教学","lang":"other","langLabel":"其他语言","gender":"female","scene":"教学"},
  {"id":"es_female_ht_mx_f6_uranus_bigtts","label":"Marisol · 通用","lang":"other","langLabel":"其他语言","gender":"female","scene":"通用"},
  {"id":"fr_male_fr_m29_uranus_bigtts","label":"Maurice · 有声阅读","lang":"other","langLabel":"其他语言","gender":"male","scene":"有声阅读"},
  {"id":"th_female_bv568_neutral_uranus_bigtts","label":"Mildred · 通用","lang":"other","langLabel":"其他语言","gender":"female","scene":"通用"},
  {"id":"pt_male_bv172narrator_uranus_bigtts","label":"Miles · 有声阅读","lang":"other","langLabel":"其他语言","gender":"male","scene":"有声阅读"},
  {"id":"ko_male_m03_uranus_bigtts","label":"Minho · 通用","lang":"other","langLabel":"其他语言","gender":"male","scene":"通用"},
  {"id":"ja_female_minimi_uranus_bigtts","label":"Minimi · 通用","lang":"other","langLabel":"其他语言","gender":"female","scene":"通用"},
  {"id":"ko_female_bv546_uranus_bigtts","label":"Momo · 视频配音","lang":"other","langLabel":"其他语言","gender":"female","scene":"视频配音"},
  {"id":"ms_male_naim_uranus_bigtts","label":"Naim · 通用","lang":"other","langLabel":"其他语言","gender":"male","scene":"通用"},
  {"id":"vi_female_partner_uranus_bigtts","label":"Partner · 视频配音","lang":"other","langLabel":"其他语言","gender":"female","scene":"视频配音"},
  {"id":"ru_male_pavel_uranus_bigtts","label":"Pavel · 通用","lang":"other","langLabel":"其他语言","gender":"male","scene":"通用"},
  {"id":"th_female_bv568_suprise_uranus_bigtts","label":"Phoebe · 有声阅读","lang":"other","langLabel":"其他语言","gender":"female","scene":"有声阅读"},
  {"id":"id_female_phulia_uranus_bigtts","label":"Phulia · 通用","lang":"other","langLabel":"其他语言","gender":"female","scene":"通用"},
  {"id":"ja_female_bv520_uranus_bigtts","label":"Poppy · 视频配音","lang":"other","langLabel":"其他语言","gender":"female","scene":"视频配音"},
  {"id":"pt_male_rael_uranus_bigtts","label":"Rael · 教学","lang":"other","langLabel":"其他语言","gender":"male","scene":"教学"},
  {"id":"id_male_bv160_uranus_bigtts","label":"Rocco · 通用","lang":"other","langLabel":"其他语言","gender":"male","scene":"通用"},
  {"id":"id_male_bv164narration_uranus_bigtts","label":"Ronan · 有声阅读","lang":"other","langLabel":"其他语言","gender":"male","scene":"有声阅读"},
  {"id":"mx_female_bv166emotion_uranus_bigtts","label":"Rosa · 通用","lang":"other","langLabel":"其他语言","gender":"female","scene":"通用"},
  {"id":"vi_female_ruan_uranus_bigtts","label":"Ruan · 通用","lang":"other","langLabel":"其他语言","gender":"female","scene":"通用"},
  {"id":"pt_male_bv172_uranus_bigtts","label":"Sam · 通用","lang":"other","langLabel":"其他语言","gender":"male","scene":"通用"},
  {"id":"ko_male_shane_uranus_bigtts","label":"Shane · 有声阅读","lang":"other","langLabel":"其他语言","gender":"male","scene":"有声阅读"},
  {"id":"ja_female_shirou_uranus_bigtts","label":"Shirou · 视频配音","lang":"other","langLabel":"其他语言","gender":"female","scene":"视频配音"},
  {"id":"ru_male_vlad_uranus_bigtts","label":"Silas · 趣味口音","lang":"other","langLabel":"其他语言","gender":"male","scene":"趣味口音"},
  {"id":"fr_female_fr_bv078_uranus_bigtts","label":"Simone · 通用","lang":"other","langLabel":"其他语言","gender":"female","scene":"通用"},
  {"id":"pt_female_bv530_uranus_bigtts","label":"Sofia · 通用","lang":"other","langLabel":"其他语言","gender":"female","scene":"通用"},
  {"id":"de_female_bv081_uranus_bigtts","label":"Stella · 教学","lang":"other","langLabel":"其他语言","gender":"female","scene":"教学"},
  {"id":"de_male_sven_uranus_bigtts","label":"Sven · 通用","lang":"other","langLabel":"其他语言","gender":"male","scene":"通用"},
  {"id":"id_female_bv161dialogue_uranus_bigtts","label":"Sylvia · 通用","lang":"other","langLabel":"其他语言","gender":"female","scene":"通用"},
  {"id":"pt_male_martins_uranus_bigtts","label":"Toby · 通用","lang":"other","langLabel":"其他语言","gender":"male","scene":"通用"},
  {"id":"fr_male_usseau_uranus_bigtts","label":"Usseau · 通用","lang":"other","langLabel":"其他语言","gender":"male","scene":"通用"},
  {"id":"th_female_bv568_hate_uranus_bigtts","label":"Valentina · 通用","lang":"other","langLabel":"其他语言","gender":"female","scene":"通用"},
  {"id":"th_female_bv568_angry_uranus_bigtts","label":"Valeria · 教学","lang":"other","langLabel":"其他语言","gender":"female","scene":"教学"},
  {"id":"pt_male_bv172emotion_uranus_bigtts","label":"Vincent · 教学","lang":"other","langLabel":"其他语言","gender":"male","scene":"教学"},
  {"id":"pt_male_bv172dialogue_uranus_bigtts","label":"Walter · 视频配音","lang":"other","langLabel":"其他语言","gender":"male","scene":"视频配音"},
  {"id":"vi_female_wu_uranus_bigtts","label":"Wu · 通用","lang":"other","langLabel":"其他语言","gender":"female","scene":"通用"},
  {"id":"vi_male_wumg_uranus_bigtts","label":"Wumg · 通用","lang":"other","langLabel":"其他语言","gender":"male","scene":"通用"},
  {"id":"ar_male_youssef_uranus_bigtts","label":"Youssef · 通用","lang":"other","langLabel":"其他语言","gender":"male","scene":"通用"},
  {"id":"th_female_bv568_happy_uranus_bigtts","label":"Zara · 通用","lang":"other","langLabel":"其他语言","gender":"female","scene":"通用"},
];

/**
 * **被排除**的名人 / 影视角色音色：只把 id 记在这里（便于以后复查），**不进下发列表**。
 * 理由是授权：这些是官方给"授权复刻"准备的，名字里带真人或影视角色。
 */
/** 名人/影视角色的 id 匹配规则（守卫用它按 id 匹配，不按名字：有几条显示名看不出来）。 */
const LIKENESS_RE = /_p1_|gollum|joker|godfather|simba|zendaya|brad_pitt|hiddleston|lana_del_rey|chandler|_rachel_|scarlet/i;

const LIKENESS_EXCLUDED = [
  "en_male_brad_pitt_p1_uranus_bigtts",
  "en_male_chandler_p1_uranus_bigtts",
  "en_male_godfather_uranus_bigtts",
  "en_male_gollum_uranus_bigtts",
  "en_male_joker_uranus_bigtts",
  "en_female_lana_del_rey_kelley_d_p1_uranus_bigtts",
  "en_female_lana_del_rey_parky_s_p1_uranus_bigtts",
  "en_female_rachel_p1_uranus_bigtts",
  "en_female_scarlet_p1_uranus_bigtts",
  "en_male_simba_p1_uranus_bigtts",
  "en_male_tom_hiddleston_p1_uranus_bigtts",
  "en_female_zendaya_p1_uranus_bigtts",
];

function allBuiltin() {
  return SPEAKERS_ZH.concat(SPEAKERS_EN, SPEAKERS_OTHER);
}

function parseOverride(text) {
  const out = [];
  for (const piece of String(text || "").split(",")) {
    const item = piece.trim();
    if (!item) continue;
    const eq = item.indexOf("=");
    const id = (eq >= 0 ? item.slice(0, eq) : item).trim();
    const label = (eq >= 0 ? item.slice(eq + 1) : "").trim();
    if (!/^[A-Za-z0-9_.:-]{2,80}$/.test(id)) continue;
    out.push({
      id,
      label: label || id,
      lang: /^en[_-]/i.test(id) ? "en" : (/^zh[_-]/i.test(id) ? "zh" : "other"),
      langLabel: /^en[_-]/i.test(id) ? "英语" : (/^zh[_-]/i.test(id) ? "中文" : "自定义"),
      gender: /_male_|^male_/i.test(id) ? "male" : (/female|_nv|nvsheng/i.test(id) ? "female" : ""),
      scene: "自定义",
    });
  }
  return out;
}

/**
 * 这一份中转实际会下发哪些音色。
 * 返回 { speakers: [...], defaultSpeaker, source }。
 */
function resolveSpeakers(env) {
  const source = env || process.env;
  const override = String(source.VOLC_TTS_SPEAKERS || "").trim();
  if (override) {
    const list = parseOverride(override);
    if (list.length) {
      const hasDefault = list.some((one) => one.id === DEFAULT_SPEAKER);
      return { speakers: list, defaultSpeaker: hasDefault ? DEFAULT_SPEAKER : list[0].id, source: "env" };
    }
  }
  const extra = parseOverride(source.VOLC_TTS_SPEAKERS_EXTRA || "");
  const speakers = allBuiltin().concat(extra);
  const hasDefault = speakers.some((one) => one.id === DEFAULT_SPEAKER);
  return {
    speakers,
    defaultSpeaker: hasDefault ? DEFAULT_SPEAKER : (speakers[0] ? speakers[0].id : ""),
    source: extra.length ? "builtin+env" : "builtin",
  };
}

/** 按 id 找音色；找不到返回 null（调用方据此拒绝这次请求）。 */
function findSpeaker(id, env) {
  const wanted = String(id || "").trim();
  if (!wanted) return null;
  const list = resolveSpeakers(env).speakers;
  return list.find((one) => one.id === wanted) || null;
}

module.exports = {
  SPEAKERS_ZH,
  SPEAKERS_EN,
  SPEAKERS_OTHER,
  LIKENESS_EXCLUDED,
  LIKENESS_RE,
  DEFAULT_SPEAKER,
  ID_RE,
  resolveSpeakers,
  findSpeaker,
  parseOverride,
};
