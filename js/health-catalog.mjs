// Stable Google Health v4 type/operation table, Filters, and Discovery rev. 20261117.
// Each descriptor defines both the partial-response mask and the permitted display fields.
export const HEALTH_SCOPE = 'https://www.googleapis.com/auth/googlehealth.';
export const categories = Object.freeze({
  activity_and_fitness: ['活動・運動', '選んだ期間の歩数、運動や活動量を確認'],
  health_metrics_and_measurements: ['身体計測・バイタル', '体重、安静時心拍などの測定値を確認'],
  nutrition: ['栄養・水分', '食事・水分記録と食品の参照情報を確認'],
  sleep: ['睡眠', '睡眠時間、ステージ、睡眠効率を確認'],
  ecg: ['心電図（ECG）', '対応機器で記録された直近24時間の結果の概要を確認'],
  irn: ['不整脈通知（IRN）', '過去の通知または登録状況を確認'],
  location: ['運動のGPS経路', '選んだ運動1件の位置と時刻を確認（活動・運動の許可も使用）'],
  profile: ['プロフィール', '利用開始日と年齢を確認'],
  settings: ['設定・ペアリング済み機器', '表示単位、タイムゾーン、機器の種類や名前を確認'],
});
export const unavailable = Object.freeze([
  ['月経期間・排卵検査・気分・症状', '公開v4では書き込み専用'],
  ['皮膚温センサーの生データ', 'v4betaのみ。安定版の夜間皮膚温とは別項目'],
  ['基礎代謝による消費エネルギー（単独）', '公開v4の型別取得操作が未提供'],
  ['Google Health公式の総合睡眠スコア・Readiness', '公開v4に取得フィールドがありません'],
]);

const activity = 'activity_and_fitness';
const measurements = 'health_metrics_and_measurements';
const f = (path, label, format, scale = 1) => ({ path, label, format, scale });
const group = (path, fields) => ({ path, fields });
const number = (path, label, unit = '', scale = 1) => f(path, label, unit || 'number', scale);
const text = (path, label) => f(path, label, 'text');
const enumeration = (path, label, enumGroup) => ({ ...f(path, label, 'enum'), enumGroup });
const minutes = (path, label) => f(path, label, 'duration');
const dated = {
  sample: ['sample_time.civil_time', 'sampleTime'],
  daily: ['date', 'date'],
  interval: ['interval.civil_start_time', 'interval'],
  session: ['interval.civil_start_time', 'interval'],
  sleep: ['interval.civil_end_time', 'interval'],
  ecg: ['interval.start_time', 'interval'],
};

function metric(id, label, scope, key, time, fields, options = {}) {
  const [filter, dateField] = dated[time] ?? [];
  const mode = options.mode ?? 'reconcile';
  return { id, label, key, time, dateField, mode, fields, scopes: [scope],
    filterKey: filter ? id.replaceAll('-', '_') + '.' + filter : undefined, ...options };
}
const daily = (id, label, key, fields) => metric(id, label, activity, key, 'rollup', fields, { mode: 'dailyRollUp' });

const activityLevel = enumeration('activityLevel', '活動強度', 'activityMinutes');
const heartZone = enumeration('heartRateZone', '心拍ゾーン', 'heartZone');
const bpm = (key, label) => number(key, label, '拍/分');
const oxygen = (key, label) => number(key, label, '%');
const vo2 = key => number(key, '最大酸素摂取量', 'mL/kg/分');
const temp = (key, label) => number(key, label, '℃');
const stage = group('summary.stagesSummary', [enumeration('type', 'ステージ', 'sleepStage'), number('minutes', '時間', '分')]);
const exerciseFields = [text('displayName', '運動名'), enumeration('exerciseType', '種目', 'exercise'),
  minutes('activeDuration', '活動時間'), number('metricsSummary.distanceMillimeters', '距離', 'km', 1e-6)];

export const metrics = Object.freeze([
  daily('active-energy-burned', '活動による消費エネルギー', 'activeEnergyBurned', [number('kcalSum', '合計', 'kcal')]),
  daily('active-minutes', '活動時間', 'activeMinutes', [group('activeMinutesRollupByActivityLevel', [activityLevel, number('activeMinutesSum', '時間', '分')])]),
  daily('active-zone-minutes', 'アクティブゾーン時間', 'activeZoneMinutes', [number('sumInFatBurnHeartZone', '脂肪燃焼', '分'), number('sumInCardioHeartZone', '有酸素', '分'), number('sumInPeakHeartZone', 'ピーク', '分')]),
  metric('activity-level', '活動強度', activity, 'activityLevel', 'interval', [enumeration('activityLevelType', '強度', 'activityType')], { latest: '日別には「活動時間」を選べます。' }),
  daily('altitude', '標高上昇', 'altitude', [number('gainMillimetersSum', '上昇量', 'm', 0.001)]),
  daily('calories-in-heart-rate-zone', '心拍ゾーン別消費エネルギー', 'caloriesInHeartRateZone', [group('caloriesInHeartRateZones', [heartZone, number('kcal', '消費', 'kcal')])]),
  metric('daily-vo2-max', '日別VO₂ max', activity, 'dailyVo2Max', 'daily', [vo2('vo2Max')]),
  daily('distance', '移動距離', 'distance', [number('millimetersSum', '距離', 'km', 1e-6)]),
  metric('exercise', '運動記録', activity, 'exercise', 'session', exerciseFields),
  daily('floors', '上った階数', 'floors', [number('countSum', '合計', '階')]),
  metric('run-vo2-max', 'ランニング時VO₂ max', activity, 'runVo2Max', 'sample', [vo2('runVo2Max')]),
  daily('sedentary-period', '座位・低活動の時間', 'sedentaryPeriod', [minutes('durationSum', '合計')]),
  daily('steps', '歩数', 'steps', [number('countSum', '合計', '歩')]),
  daily('swim-lengths-data', '水泳のストローク', 'swimLengthsData', [number('strokeCountSum', '合計', '回')]),
  daily('time-in-heart-rate-zone', '心拍ゾーン別時間', 'timeInHeartRateZone', [group('timeInHeartRateZones', [heartZone, minutes('duration', '時間')])]),
  daily('total-calories', '総消費エネルギー', 'totalCalories', [number('kcalSum', '合計', 'kcal')]),
  metric('vo2-max', 'VO₂ max', activity, 'vo2Max', 'sample', [vo2('vo2Max')]),
  metric('blood-glucose', '血糖', measurements, 'bloodGlucose', 'sample', [number('bloodGlucoseMilligramsPerDeciliter', '血糖', 'mg/dL')]),
  metric('body-fat', '体脂肪率', measurements, 'bodyFat', 'sample', [number('percentage', '体脂肪率', '%')]),
  metric('core-body-temperature', '深部体温', measurements, 'coreBodyTemperature', 'sample', [temp('temperatureCelsius', '体温')]),
  metric('daily-heart-rate-variability', '日別心拍変動', measurements, 'dailyHeartRateVariability', 'daily', [number('averageHeartRateVariabilityMilliseconds', '平均', 'ms')]),
  metric('daily-heart-rate-zones', '日別心拍ゾーン', measurements, 'dailyHeartRateZones', 'daily', [group('heartRateZones', [enumeration('heartRateZoneType', 'ゾーン', 'heartZone'), bpm('minBeatsPerMinute', '下限'), bpm('maxBeatsPerMinute', '上限')])]),
  metric('daily-oxygen-saturation', '日別血中酸素飽和度', measurements, 'dailyOxygenSaturation', 'daily', [oxygen('averagePercentage', '平均'), oxygen('lowerBoundPercentage', '下限'), oxygen('upperBoundPercentage', '上限')]),
  metric('daily-respiratory-rate', '日別呼吸数', measurements, 'dailyRespiratoryRate', 'daily', [number('breathsPerMinute', '呼吸数', '回/分')]),
  metric('daily-resting-heart-rate', '安静時心拍', measurements, 'dailyRestingHeartRate', 'daily', [bpm('beatsPerMinute', '安静時心拍')]),
  metric('daily-sleep-temperature-derivations', '夜間皮膚温', measurements, 'dailySleepTemperatureDerivations', 'daily', [temp('nightlyTemperatureCelsius', '夜間温度'), temp('baselineTemperatureCelsius', '基準温度')]),
  metric('heart-rate', '心拍（日別集計）', measurements, 'heartRate', 'rollup', [bpm('beatsPerMinuteAvg', '平均'), bpm('beatsPerMinuteMin', '最低'), bpm('beatsPerMinuteMax', '最高')], { mode: 'dailyRollUp' }),
  metric('heart-rate-variability', '心拍変動の測定値', measurements, 'heartRateVariability', 'sample', [number('rootMeanSquareOfSuccessiveDifferencesMilliseconds', 'RMSSD', 'ms')], { latest: '日別には「日別心拍変動」を選べます。' }),
  metric('height', '身長', measurements, 'height', 'sample', [number('heightMillimeters', '身長', 'cm', 0.1)]),
  metric('oxygen-saturation', '血中酸素飽和度の測定値', measurements, 'oxygenSaturation', 'sample', [oxygen('percentage', '血中酸素飽和度')], { latest: '日別には「日別血中酸素飽和度」を選べます。' }),
  metric('respiratory-rate-sleep-summary', '睡眠中の呼吸数', measurements, 'respiratoryRateSleepSummary', 'sample',
    ['full', 'deep', 'light', 'rem'].map((phase, i) => number(phase + 'SleepStats.breathsPerMinute', ['睡眠全体', '深い睡眠', '浅い睡眠', 'レム睡眠'][i], '回/分'))),
  metric('weight', '体重', measurements, 'weight', 'sample', [number('weightGrams', '体重', 'kg', 0.001)]),
  metric('hydration-log', '水分摂取', 'nutrition', 'hydrationLog', 'session', [number('amountConsumed.milliliters', '水分', 'mL')]),
  metric('nutrition-log', '食事記録', 'nutrition', 'nutritionLog', 'session', [text('foodDisplayName', '食品'), number('energy.kcal', 'エネルギー', 'kcal'), number('totalFat.grams', '脂質', 'g'), number('totalCarbohydrate.grams', '炭水化物', 'g')]),
  metric('food', '食品の参照一覧', 'nutrition', 'food', 'reference', [text('displayName', '食品'), text('brand', 'ブランド'), number('energyAvg.kcal', '表示エネルギー', 'kcal')], { mode: 'list' }),
  metric('food-measurement-unit', '食品の計量単位', 'nutrition', 'foodMeasurementUnit', 'reference', [text('displayName', '単位')], { mode: 'list' }),
  metric('sleep', '睡眠', 'sleep', 'sleep', 'sleep', [
    f('summary.minutesAsleep', '睡眠時間', 'sleepDuration'), number('summary.minutesInSleepPeriod', '睡眠期間', '分'),
    f('metadata.mainSleep', '主な睡眠', 'flag'), enumeration('metadata.stagesStatus', 'ステージの状態', 'stagesStatus'), enumeration('type', '睡眠の記録方式', 'sleepType'), stage]),
  metric('electrocardiogram', '心電図の記録概要', 'ecg', 'electrocardiogram', 'ecg',
    [enumeration('resultClassification', '機器の分類', 'ecg'), bpm('beatsPerMinuteAvg', '平均心拍')], { mode: 'list' }),
  metric('irregular-rhythm-notification', '不整脈通知の記録', 'irn', 'irregularRhythmNotification', 'session',
    [group('alertWindows', [f('civilStartTime', '検出区間の開始', 'datetime'), f('positive', '通知対象の区間', 'flag')])], { mode: 'list' }),
]);

const resource = (id, label, scope, fields, listKey) => ({
  id, label, scopes: [scope], mode: 'resource', fields, listKey,
});
export const resources = Object.freeze([
  resource('irnProfile', '不整脈通知の登録状況', 'irn', [f('onboardingStatus', '初期設定済み', 'flag'), f('enrollmentStatus', '登録済み', 'flag'), f('updateTime', '更新日時', 'utc')]),
  resource('profile', 'プロフィール', 'profile', [f('membershipStartDate', '利用開始日', 'date'), number('age', '年齢', '歳')]),
  resource('settings', 'Google Healthの設定', 'settings', ['weight', 'height', 'distance', 'water', 'temperature', 'glucose', 'swim'].map((unit, i) =>
    enumeration(unit + 'Unit', ['体重', '身長', '距離', '水分', '温度', '血糖', '水泳'][i] + 'の単位', unit + 'Unit')).concat(text('timeZone', 'タイムゾーン'))),
  resource('pairedDevices', 'ペアリング済み機器', 'settings',
    [text('deviceVersion', '機器'), enumeration('deviceType', '機器の種類', 'deviceType'), f('lastSyncTime', '最終同期', 'utc')], 'pairedDevices'),
  { ...resource('profile-stride', '歩行・ランニングの歩幅設定', 'profile', [
    number('userConfiguredWalkingStrideLengthMm', '歩行（設定値）', 'cm', 0.1),
    number('userConfiguredRunningStrideLengthMm', 'ランニング（設定値）', 'cm', 0.1),
    number('autoWalkingStrideLengthMm', '歩行（自動）', 'cm', 0.1),
    number('autoRunningStrideLengthMm', 'ランニング（自動）', 'cm', 0.1),
  ]), endpoint: 'profile', scopes: ['profile', activity] },
]);
export const gps = Object.freeze({ ...metrics.find(({ id }) => id === 'exercise'), id: 'gps',
  label: '運動を選んでGPS経路を表示', scopes: [activity, 'location'], gps: true });

export const catalog = Object.freeze([...metrics, ...resources, gps]);
