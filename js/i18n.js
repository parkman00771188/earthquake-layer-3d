/**
 * Korean / Japanese / English UI strings.
 *
 * The Korean text is the key: markup keeps its original wording (readable in
 * the file, and the fallback if a translation is missing) and carries a
 * `data-i18n` attribute so applyI18n() can swap it. Attributes use
 * `data-i18n-title` / `data-i18n-aria`.
 *
 * Default language follows where the visitor is: the browser's time zone first
 * (Asia/Seoul, Asia/Tokyo), then its language list, then English. A manual
 * choice is remembered.
 */

const KEY = 'jq4d.lang';

export const LANGS = [
  ['en', 'English'],
  ['ja', '日本語'],
  ['ko', '한국어'],
];

/* ko -> { en, ja } */
const DICT = {
  '일본 주변 지진 4D': { en: 'Earthquake 4D', ja: '地震 4D' },
  '일본 주변 지진': { en: 'Earthquakes around Japan', ja: '日本周辺の地震' },
  '전세계 지진': { en: 'World Earthquakes', ja: '世界の地震' },
  '데이터 불러오는 중…': { en: 'Loading data…', ja: 'データ読み込み中…' },
  '표시 중': { en: 'Shown', ja: '表示中' },
  '전체': { en: 'All', ja: '全体' },
  '최대': { en: 'Max', ja: '最大' },
  '일본': { en: 'Japan', ja: '日本' },
  '전세계': { en: 'World', ja: '世界' },
  '업데이트': { en: 'Updated', ja: '更新' },
  // Relative "updated N ago" units. The en values carry their own leading
  // space so `${n}${t('분 전')}` reads "5 min ago" / "5분 전" / "5分前".
  '방금 전': { en: 'just now', ja: 'たった今' },
  '분 전': { en: ' min ago', ja: '分前' },
  '시간 전': { en: ' hr ago', ja: '時間前' },
  '일 전': { en: ' days ago', ja: '日前' },
  '메뉴': { en: 'Menu', ja: 'メニュー' },
  '보기 범위': { en: 'View', ja: '表示範囲' },
  '최대 규모': { en: 'Max magnitude', ja: '最大規模' },
  '최근 지진 목록': { en: 'Recent earthquakes', ja: '最近の地震一覧' },
  '지도 · 레이어 설정': { en: 'Map & layers', ja: '地図・レイヤー設定' },
  '필터 · 시각 설정': { en: 'Filters & display', ja: 'フィルター・表示設定' },
  '데이터 업데이트': { en: 'Update data', ja: 'データ更新' },
  '기간 설정': { en: 'Set period', ja: '期間設定' },
  '시작': { en: 'From', ja: '開始' },
  '종료': { en: 'To', ja: '終了' },
  '7일': { en: '7 days', ja: '7日' },
  '한달': { en: '1 month', ja: '1ヶ月' },
  '1년': { en: '1 year', ja: '1年' },
  '10년': { en: '10 years', ja: '10年' },
  '50년': { en: '50 years', ja: '50年' },
  '적용': { en: 'Apply', ja: '適用' },
  '최근 지진': { en: 'Recent earthquakes', ja: '最近の地震' },
  '최근 발생': { en: 'Recent', ja: '最近の発生' },
  '전체 보기': { en: 'See all', ja: 'すべて表示' },
  '불러오는 중…': { en: 'Loading…', ja: '読み込み中…' },
  '목록 끝': { en: 'End of list', ja: '一覧の終わり' },
  '이 시점 이전에 표시할 지진이 없습니다.': {
    en: 'No earthquakes to show before this moment.',
    ja: 'この時点より前に表示する地震がありません。',
  },
  '현재 시점 기준 최근 N건 · 필터·기간 적용 · 클릭하면 위치가 표시됩니다': {
    en: 'Latest N at the playhead · filters and period applied · tap to locate',
    ja: '現在時点の最新N件・フィルターと期間を適用・タップで位置表示',
  },
  '깊이 (km)': { en: 'Depth (km)', ja: '深さ (km)' },
  '규모 (M)': { en: 'Magnitude (M)', ja: '規模 (M)' },
  '경과 시간': { en: 'Time', ja: '経過時間' },
  '밀도 (균일 색)': { en: 'Density (single colour)', ja: '密度 (単色)' },
  '지도 · 레이어': { en: 'Map & layers', ja: '地図・レイヤー' },
  '필터 · 설정': { en: 'Filters & settings', ja: 'フィルター・設定' },
  '표시 방식': { en: 'Display mode', ja: '表示方式' },
  '누적': { en: 'Accumulate', ja: '累積' },
  '이동 구간': { en: 'Moving window', ja: '移動区間' },
  '시작부터 현재 시점까지 모든 지진이 남습니다. 점이 쌓이며 밀집 구역이 드러납니다.': {
    en: 'Every quake from the start stays on screen; the dots pile up and dense zones emerge.',
    ja: '開始から現在までのすべての地震が残ります。点が重なり密集域が浮かび上がります。',
  },
  '현재 시점에서 뒤로 정해진 기간만 표시합니다. 지진의 이동과 여진 전개를 보기에 좋습니다.': {
    en: 'Shows only a fixed span behind the playhead — good for watching migration and aftershocks.',
    ja: '現在時点から一定期間だけ表示します。地震の移動や余震の展開を見るのに適しています。',
  },
  '구간 길이': { en: 'Window length', ja: '区間の長さ' },
  '과거 지진 진하기': { en: 'Older quakes opacity', ja: '過去の地震の濃さ' },
  '꼬리 진하기': { en: 'Trail opacity', ja: '尾の濃さ' },
  '최근 강조 기간': { en: 'Recent highlight', ja: '最近の強調期間' },
  '기간': { en: 'Period', ja: '期間' },
  '끝': { en: 'To', ja: '終了' },
  '최근 10년': { en: 'Last 10 years', ja: '直近10年' },
  '최근 1년': { en: 'Last year', ja: '直近1年' },
  '최근 30일': { en: 'Last 30 days', ja: '直近30日' },
  '최근 7일': { en: 'Last 7 days', ja: '直近7日' },
  '선택한 기간만 그려지고 재생도 그 안에서 반복됩니다. 아래 시간바의 양 끝 손잡이를 끌어 조절할 수도 있습니다.': {
    en: 'Only the selected period is drawn, and playback loops inside it. '
      + 'You can also drag the handles at either end of the timeline.',
    ja: '選択した期間だけが描画され、再生もその中で繰り返されます。'
      + '下のタイムバーの両端のつまみをドラッグして調整することもできます。',
  },
  '최신 지진을 반영하려면 update.bat 을 실행하세요.': {
    en: 'Run update.bat to pull in the latest earthquakes.',
    ja: '最新の地震を反映するには update.bat を実行してください。',
  },
  '규모': { en: 'Magnitude', ja: '規模' },
  '규모 M': { en: 'Magnitude M', ja: '規模 M' },
  '끄면 해당 규모대(예: M3 = M3.0–3.9)가 화면·목록·통계에서 제외됩니다.': {
    en: 'Turning one off removes that band (e.g. M3 = M3.0–3.9) from the map, list and stats.',
    ja: 'オフにするとその規模帯 (例: M3 = M3.0–3.9) が画面・一覧・統計から除外されます。',
  },
  '깊이': { en: 'Depth', ja: '深さ' },
  '깊이 km': { en: 'Depth km', ja: '深さ km' },
  '얕은': { en: 'Shallow', ja: '浅い' },
  '중간': { en: 'Mid', ja: '中間' },
  '깊은': { en: 'Deep', ja: '深い' },
  '시각': { en: 'Display', ja: '表示' },
  '깊이 과장': { en: 'Depth exaggeration', ja: '深さの強調' },
  '점 크기': { en: 'Dot size', ja: '点の大きさ' },
  '규모별 점 크기': { en: 'Dot size by magnitude', ja: '規模別の点の大きさ' },
  '(M3 = M3.0–3.9 전체)': { en: '(M3 = all of M3.0–3.9)', ja: '(M3 = M3.0–3.9 全体)' },
  '전체 배율': { en: 'Overall scale', ja: '全体倍率' },
  '기본값으로': { en: 'Reset to defaults', ja: '初期値に戻す' },
  '선명도': { en: 'Sharpness', ja: '鮮明度' },
  '불투명도': { en: 'Opacity', ja: '不透明度' },
  '색상 기준': { en: 'Colour by', ja: '色の基準' },
  '시간': { en: 'Time', ja: '時間' },
  '밀도': { en: 'Density', ja: '密度' },
  '발광 합성': { en: 'Additive glow', ja: '発光合成' },
  '(밀집 강조)': { en: '(density boost)', ja: '(密集強調)' },
  '자동 회전': { en: 'Auto-rotate', ja: '自動回転' },
  '지도': { en: 'Map', ja: '地図' },
  '지도 스타일': { en: 'Map style', ja: '地図スタイル' },
  '없음': { en: 'None', ja: 'なし' },
  '면 채우기': { en: 'Flat fill', ja: '塗りつぶし' },
  '위성사진': { en: 'Satellite', ja: '衛星写真' },
  '지도 불투명도': { en: 'Map opacity', ja: '地図の不透明度' },
  '바다 표시': { en: 'Show ocean', ja: '海を表示' },
  '(해저 지형)': { en: '(seafloor relief)', ja: '(海底地形)' },
  '해안선': { en: 'Coastline', ja: '海岸線' },
  '행정 경계': { en: 'Admin borders', ja: '行政境界' },
  '(도·현)': { en: '(prefectures)', ja: '(県)' },
  '판 경계': { en: 'Plate boundaries', ja: 'プレート境界' },
  '활성 단층': { en: 'Active faults', ja: '活断層' },
  '화산': { en: 'Volcanoes', ja: '火山' },
  '전지구 화산활동 프로그램 — 홀로세 화산 위치': {
    en: 'Global Volcanism Program — Holocene volcano locations',
    ja: '全地球火山活動プログラム — 完新世の火山位置',
  },
  '판 경계 굵기': { en: 'Plate line width', ja: 'プレート境界の太さ' },
  '활성 단층 굵기': { en: 'Fault line width', ja: '活断層の太さ' },
  '행정 경계 굵기': { en: 'Border line width', ja: '行政境界の太さ' },
  '전세계 활성단층 데이터베이스 — 지도의 단층 선': {
    en: 'Global active fault database — the fault lines on the map',
    ja: '世界活断層データベース — 地図の断層線',
  },
  '새 데이터 있음': { en: 'New data', ja: '新データあり' },
  '클릭하면 새 데이터로 새로고침합니다': {
    en: 'Click to reload with the new data',
    ja: 'クリックで新しいデータに更新します',
  },
  '깊이 상자 · 격자': { en: 'Depth box & grid', ja: '深さボックス・格子' },
  '면 채우기는 Natural Earth 육지 마스크, 위성사진은 NASA Blue Marble 영상입니다.': {
    en: 'Flat fill uses the Natural Earth land mask; satellite imagery is NASA Blue Marble.',
    ja: '塗りつぶしは Natural Earth の陸地マスク、衛星写真は NASA Blue Marble です。',
  },
  '시점': { en: 'Viewpoint', ja: '視点' },
  '입체': { en: '3D', ja: '立体' },
  '위 (지도)': { en: 'Top (map)', ja: '上 (地図)' },
  '남→북 단면': { en: 'S→N section', ja: '南→北 断面' },
  '동→서 단면': { en: 'E→W section', ja: '東→西 断面' },
  '일본해구': { en: 'Japan Trench', ja: '日本海溝' },
  '드래그 회전 · 휠 확대 · 우클릭 드래그 이동. 점을 클릭하면 상세 정보가 나옵니다.': {
    en: 'Drag to rotate · wheel to zoom · right-drag to pan. Click a dot for details.',
    ja: 'ドラッグで回転・ホイールで拡大・右ドラッグで移動。点をクリックすると詳細が出ます。',
  },
  '최근 갱신 내역': { en: 'Latest update', ja: '最近の更新履歴' },
  '확인 중…': { en: 'Checking…', ja: '確認中…' },
  '내역 보기': { en: 'Show details', ja: '履歴を見る' },
  '접기': { en: 'Collapse', ja: '折りたたむ' },
  '데이터': { en: 'Data', ja: 'データ' },
  '수록 기간': { en: 'Coverage', ja: '収録期間' },
  '갱신 시각': { en: 'Built at', ja: '更新時刻' },
  '설정은 이 브라우저에 자동 저장됩니다': {
    en: 'Settings are saved in this browser',
    ja: '設定はこのブラウザに自動保存されます',
  },
  '초기화': { en: 'Reset', ja: '初期化' },
  '데이터 파일이 서로 맞지 않습니다': {
    en: 'The data files disagree with each other', ja: 'データファイルが一致しません' },
  '저장된 설정을 지웠습니다. 새로고침하면 기본값으로 시작합니다.': {
    en: 'Saved settings cleared. Reload to start from the defaults.',
    ja: '保存された設定を消しました。再読み込みで初期値から始まります。' },
  '일시정지': { en: 'Pause', ja: '一時停止' },
  '데이터': { en: 'Data', ja: 'データ' },
  '수록': { en: 'Coverage', ja: '収録' },
  '갱신': { en: 'Updated', ja: '更新' },
  'ISC (JMA 포함)': { en: 'ISC (incl. JMA)', ja: 'ISC (JMA 含む)' },
  '겹칠수록 밝아집니다 — 발광 합성 권장': {
    en: 'Brighter where events overlap — additive glow recommended',
    ja: '重なるほど明るくなります — 発光合成を推奨' },
  '(이름 없음)': { en: '(unnamed)', ja: '(名称なし)' },
  'ISC 상세 페이지 ↗': { en: 'ISC event page ↗', ja: 'ISC 詳細ページ ↗' },
  'USGS 상세 페이지 ↗': { en: 'USGS event page ↗', ja: 'USGS 詳細ページ ↗' },
  '메타데이터 확인 중…': { en: 'Checking metadata…', ja: 'メタデータ確認中…' },
  '지명 · 기준 지형 불러오는 중…': {
    en: 'Loading place names and basemap…', ja: '地名・基準地形を読み込み中…' },
  '장면 구성 중…': { en: 'Building the scene…', ja: 'シーンを構成中…' },
  '전세계 데이터 불러오는 중…': {
    en: 'Loading worldwide data…', ja: '世界のデータを読み込み中…' },
  '전세계 지진 병합 중…': { en: 'Merging worldwide events…', ja: '世界の地震を統合中…' },
  '전세계 데이터를 불러오지 못했습니다. update_global.bat 로 생성하세요.': {
    en: 'Could not load the worldwide data. Run update_global.bat to build it.',
    ja: '世界のデータを読み込めません。update_global.bat で生成してください。' },
  '갱신 기록이 없습니다 (아직 update를 실행하지 않음).': {
    en: 'No update history yet (update has not been run).',
    ja: '更新履歴がありません (update 未実行)。' },
  '변경된 지진이 없습니다.': { en: 'No events changed.', ja: '変更された地震はありません。' },
  '신규': { en: 'New', ja: '新規' },
  '대체': { en: 'Replaced', ja: '置換' },
  '목록이 길어 일부만 표시했습니다.': {
    en: 'The list was long, so only part of it is shown.',
    ja: '一覧が長いため一部のみ表示しています。' },
  '지진 데이터 불러오는 중…': {
    en: 'Loading earthquakes…', ja: '地震データを読み込み中…' },
  '수정': { en: 'Revised', ja: '修正' },
  '위도': { en: 'Latitude', ja: '緯度' },
  '경도': { en: 'Longitude', ja: '経度' },
  '발생시각': { en: 'Origin time', ja: '発生時刻' },
  '규모종류': { en: 'Magnitude type', ja: '規模の種類' },
  '지명': { en: 'Place', ja: '地名' },
  '언어': { en: 'Language', ja: '言語' },
  '글자 크기': { en: 'Text size', ja: '文字サイズ' },
  '작게': { en: 'Small', ja: '小' },
  '보통': { en: 'Normal', ja: '標準' },
  '크게': { en: 'Large', ja: '大' },
  '아주 크게': { en: 'X-large', ja: '特大' },
  '확대 · 축소': { en: 'Zoom', ja: '拡大・縮小' },
  '두 손가락을 벌리거나': { en: 'Spread two fingers apart', ja: '2本の指を広げたり' },
  '오므려 보세요': { en: 'or pinch them together', ja: 'つまんだりします' },
  '화면 이동': { en: 'Pan', ja: '画面移動' },
  '두 손가락을 붙여서': { en: 'Keep two fingers together', ja: '2本の指をそろえて' },
  '끌어 보세요': { en: 'and drag', ja: 'ドラッグします' },
  '한 손가락 드래그는 회전입니다': {
    en: 'One finger drags to rotate',
    ja: '1本指のドラッグは回転です',
  },
  '확인': { en: 'Got it', ja: 'OK' },
  '데이터 출처': { en: 'Data sources', ja: 'データ出典' },
  '국제지진센터 게시록 — 전 세계 130여 관측망을 종합한 검토 카탈로그로, 일본 기상청(JMA) 자료를 포함합니다.': {
    en: 'ISC Bulletin — the reviewed catalogue that merges ~130 networks worldwide, including JMA.',
    ja: 'ISC 会報 — 世界約130の観測網を統合した査読済みカタログで、気象庁(JMA)のデータを含みます。',
  },
  '미국 지질조사국 지진 카탈로그 — 최근 지진을 실시간에 가깝게 반영합니다.': {
    en: 'USGS ANSS ComCat — near-real-time coverage of recent earthquakes.',
    ja: 'USGS ANSS ComCat — 最近の地震をほぼリアルタイムで反映します。',
  },
  '해안선·판 경계·육지 마스크': { en: 'Coastlines, plate boundaries, land mask', ja: '海岸線・プレート境界・陸地マスク' },
  '위성 영상 — Blue Marble Next Generation. 2004년 Terra 위성 MODIS 관측을 월별로 합성한 500m 해상도 무운(無雲) 영상에 해저 지형 음영을 더한 것입니다.': {
    en: 'Satellite imagery — Blue Marble Next Generation: monthly cloud-free composites at '
      + '500 m from Terra/MODIS in 2004, with seafloor relief shading added.',
    ja: '衛星画像 — Blue Marble Next Generation。2004年の Terra/MODIS 観測を月ごとに合成した'
      + '500m 解像度の無雲画像に、海底地形の陰影を加えたものです。',
  },
  '1일 / 초': { en: '1 day / sec', ja: '1日 / 秒' },
  '1주일 / 초': { en: '1 week / sec', ja: '1週間 / 秒' },
  '1개월 / 초': { en: '1 month / sec', ja: '1ヶ月 / 秒' },
  '3개월 / 초': { en: '3 months / sec', ja: '3ヶ月 / 秒' },
  '5개월 / 초': { en: '5 months / sec', ja: '5ヶ月 / 秒' },
  '1년 / 초': { en: '1 year / sec', ja: '1年 / 秒' },
  '3년 / 초': { en: '3 years / sec', ja: '3年 / 秒' },
  '5년 / 초': { en: '5 years / sec', ja: '5年 / 秒' },
  '10년 / 초': { en: '10 years / sec', ja: '10年 / 秒' },
  '반복': { en: 'Loop', ja: '繰り返し' },
  '처음으로': { en: 'Restart', ja: '最初へ' },
  '발생 (UTC)': { en: 'Origin (UTC)', ja: '発生 (UTC)' },
  '발생 (현지 시각)': { en: 'Origin (local)', ja: '発生 (現地時間)' },
  '경도 기반 근사 — 실제 법정 시간대와 다를 수 있습니다': {
    en: 'Longitude-based estimate — may differ from the legal time zone',
    ja: '経度による推定 — 法定時間帯と異なる場合があります',
  },
  '위치': { en: 'Location', ja: '位置' },
  '데이터를 불러올 수 없습니다': { en: 'Could not load the data', ja: 'データを読み込めません' },
  '데이터 정보': { en: 'About the data', ja: 'データ情報' },
  '데이터 갱신': { en: 'Refresh data', ja: 'データ更新' },
  '지도 레이어': { en: 'Map layers', ja: '地図レイヤー' },
  '필터 및 설정': { en: 'Filters and settings', ja: 'フィルターと設定' },
  '닫기': { en: 'Close', ja: '閉じる' },
  '목록 닫기': { en: 'Close list', ja: '一覧を閉じる' },
  '패널 접기/펴기': { en: 'Toggle panel', ja: 'パネル開閉' },
  '필터 초기화': { en: 'Reset filters', ja: 'フィルター初期化' },
  '재생': { en: 'Play', ja: '再生' },
  '기간 시작': { en: 'Period start', ja: '期間の開始' },
  '기간 끝': { en: 'Period end', ja: '期間の終了' },
  '재생 속도': { en: 'Playback speed', ja: '再生速度' },
  '갱신 중…': { en: 'Updating…', ja: '更新中…' },
  '갱신 완료 · 새로고침': { en: 'Updated · reloading', ja: '更新完了・再読込' },
  '갱신 실패': { en: 'Update failed', ja: '更新に失敗' },
  '최신 데이터 확인 중…': { en: 'Checking for new data…', ja: '最新データを確認中…' },
  '숨김': { en: 'hidden', ja: '非表示' },
  '없음(강조 안 함)': { en: 'off', ja: 'なし' },
  '1주': { en: '1 week', ja: '1週' },
  '2주': { en: '2 weeks', ja: '2週' },
  '1개월': { en: '1 month', ja: '1ヶ月' },
  '3개월': { en: '3 months', ja: '3ヶ月' },
  '6개월': { en: '6 months', ja: '6ヶ月' },
  '9개월': { en: '9 months', ja: '9ヶ月' },
  '2년': { en: '2 years', ja: '2年' },
  '5년': { en: '5 years', ja: '5年' },
  '20년': { en: '20 years', ja: '20年' },
};

let lang = 'ko';

export function detectLang() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && LANGS.some(([c]) => c === saved)) return saved;
  } catch { /* private mode */ }

  // Where you are beats what your browser is set to: a Korean-language phone
  // in Tokyo is still looking at Japanese seismicity.
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    if (tz === 'Asia/Seoul') return 'ko';
    if (tz === 'Asia/Tokyo') return 'ja';
  } catch { /* no Intl */ }

  for (const l of navigator.languages ?? [navigator.language ?? '']) {
    const code = String(l).toLowerCase();
    if (code.startsWith('ko')) return 'ko';
    if (code.startsWith('ja')) return 'ja';
  }
  return 'en';
}

export function getLang() { return lang; }

export function setLang(code, { persist = true } = {}) {
  lang = LANGS.some(([c]) => c === code) ? code : 'en';
  document.documentElement.lang = lang;
  if (persist) {
    try { localStorage.setItem(KEY, lang); } catch { /* private mode */ }
  }
  applyI18n();
}

/** Translate one Korean source string. */
export function t(ko) {
  if (lang === 'ko') return ko;
  return DICT[ko]?.[lang] ?? ko;
}

/** Swap every tagged node/attribute in the document to the active language. */
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle);
  }
  for (const el of root.querySelectorAll('[data-i18n-aria]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  }
}

/* ── viewer time zone ─────────────────────────────────────────
   Timestamps in the rolling lists read in the visitor's own clock; the
   abbreviation (KST, JST, PDT, UTC+7 ...) is shown once next to the list
   title so rows stay compact. */

const TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
})();

// Intl's short names for most Asian zones are just "GMT+9"; these are the
// household abbreviations for the audiences this site actually has.
const TZ_ABBR = {
  'Asia/Seoul': 'KST', 'Asia/Tokyo': 'JST', 'Asia/Shanghai': 'CST',
  'Asia/Taipei': 'CST', 'Asia/Hong_Kong': 'HKT', 'Asia/Singapore': 'SGT',
  UTC: 'UTC', 'Etc/UTC': 'UTC',
};

/** Short label for the viewer's zone: "KST", "PDT", "UTC+7", ... */
export function tzAbbr(d = new Date()) {
  if (TZ_ABBR[TZ]) return TZ_ABBR[TZ];
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'short' })
      .formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? 'UTC';
    return name.replace(/^GMT/, 'UTC');
  } catch {
    return 'UTC';
  }
}

// sv-SE is the one locale whose default pattern is already "YYYY-MM-DD HH:MM".
const LOCAL_FMT = (() => {
  try {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch { return null; }
})();

/** "YYYY-MM-DD HH:MM" in the viewer's time zone. */
export function fmtLocal(d) {
  return LOCAL_FMT ? LOCAL_FMT.format(d) : d.toISOString().slice(0, 16).replace('T', ' ');
}

/** Locale-aware long date, e.g. 2026년 7월 30일 / 2026年7月30日 / Jul 30, 2026. */
export function fmtDate(d) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  if (lang === 'ko') return `${y}년 ${m}월 ${day}일`;
  if (lang === 'ja') return `${y}年${m}月${day}日`;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MON[m - 1]} ${day}, ${y}`;
}

/** "60일" / "60 days" / "60日" */
export function fmtDays(n) {
  if (lang === 'ko') return `${n}일`;
  if (lang === 'ja') return `${n}日`;
  return `${n} day${n === 1 ? '' : 's'}`;
}

/** "1,234건" / "1,234件" / "1,234". */
export function count(n) {
  const s = numFmt().format(n);
  return lang === 'ko' ? `${s}건` : lang === 'ja' ? `${s}件` : s;
}

const NF = { ko: 'ko-KR', ja: 'ja-JP', en: 'en-US' };
export function numFmt() { return new Intl.NumberFormat(NF[lang] ?? 'en-US'); }
