import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Location from 'expo-location';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { initialWindowMetrics, SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ApiRequestError, confirmPinRecovery, CorrectionRequest, discardFirstPendingScan, getCorrectionRequests, getNotifications, getTimesheet, isNetworkFailure, logout, markNotificationRead, pendingScanCount, queueScan, registerAccount, registerScan, requestPinRecovery, restoreSession, submitCorrection, syncPendingScans, TimesheetDay, WorkerNotification } from './src/api';
import { Language, loadLanguage, saveLanguage, translate, TranslationKey, uiMessage } from './src/i18n';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

type Screen = 'signup' | 'recovery' | 'home' | 'scanner' | 'timesheet' | 'correction' | 'notifications';
type ScanResult = { action: 'IN' | 'OUT'; site: string; gate: string };

export default function App() {
  const [screen, setScreen] = useState<Screen>('signup');
  const [language, setLanguage] = useState<Language>('et');
  const [sessionLoading, setSessionLoading] = useState(true);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [recoveryChallengeId, setRecoveryChallengeId] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [newPin, setNewPin] = useState('');
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [scanLocked, setScanLocked] = useState(false);
  const scanLockRef = useRef(false);
  const [timesheet, setTimesheet] = useState<TimesheetDay[]>([]);
  const [timesheetLoading, setTimesheetLoading] = useState(false);
  const [timesheetError, setTimesheetError] = useState<string | null>(null);
  const [correctionDate, setCorrectionDate] = useState('2026-07-18');
  const [correctionIn, setCorrectionIn] = useState('07:42');
  const [correctionOut, setCorrectionOut] = useState('16:15');
  const [correctionReason, setCorrectionReason] = useState('Unustasin OUT-koodi skaneerida');
  const [correctionRequests, setCorrectionRequests] = useState<CorrectionRequest[]>([]);
  const [correctionsLoading, setCorrectionsLoading] = useState(false);
  const [notifications, setNotifications] = useState<WorkerNotification[]>([]);
  const [pendingScans, setPendingScans] = useState(0);
  const [syncError, setSyncError] = useState<string | null>(null);
  const t = (key: TranslationKey) => translate(language, key);
  const m = (message: string) => uiMessage(language, message);

  useEffect(() => { loadLanguage().then(setLanguage); }, []);

  async function changeLanguage(next: Language) {
    setLanguage(next);
    await saveLanguage(next);
  }

  useEffect(() => {
    restoreSession().then((account) => {
      if (account) {
        setName(account.name);
        setPhone(account.phone);
        setScreen('home');
      }
    }).finally(() => setSessionLoading(false));
  }, []);

  function confirmLogout() {
    Alert.alert(m('Logi välja?'), m('Uuesti sisenemiseks on vaja telefoninumbrit ja PIN-koodi.'), [
      { text: m('Tühista'), style: 'cancel' },
      { text: m('Logi välja'), style: 'destructive', onPress: async () => { await logout(); setPin(''); setScreen('signup'); } },
    ]);
  }

  async function syncQueue(showResult = false) {
    const result = await syncPendingScans();
    setPendingScans(result.pending);
    setSyncError(result.lastError ?? null);
    if (showResult && result.synced > 0) Alert.alert(m('Sünkroonitud'), language === 'fi' ? `${result.synced} kirjausta lähetettiin palvelimelle.` : language === 'en' ? `${result.synced} registrations were sent to the server.` : `${result.synced} registreeringut saadeti serverisse.`);
  }

  function discardFailedScan() {
    Alert.alert(m('Eemalda registreering?'), m('Eemaldatud kannet serverisse ei saadeta. Vajadusel esita tunnilehe parandustaotlus.'), [
      { text: m('Tühista'), style: 'cancel' },
      { text: m('Eemalda'), style: 'destructive', onPress: async () => { setPendingScans(await discardFirstPendingScan()); setSyncError(null); } },
    ]);
  }

  useEffect(() => {
    if (screen !== 'home') return;
    pendingScanCount().then(setPendingScans);
    getNotifications().then(setNotifications).catch(() => undefined);
    syncQueue();
    const timer = setInterval(() => syncQueue(), 15_000);
    return () => clearInterval(timer);
  }, [screen]);

  async function openNotifications() {
    setNotifications(await getNotifications());
    setScreen('notifications');
  }

  async function readNotification(notification: WorkerNotification) {
    if (!notification.readAt) await markNotificationRead(notification.id);
    setNotifications((rows) => rows.map((row) => row.id === notification.id ? { ...row, readAt: row.readAt ?? new Date().toISOString() } : row));
  }

  async function sendCorrection() {
    if (!correctionReason.trim()) return Alert.alert(m('Põhjendus puudub'), m('Sisesta paranduse põhjus.'));
    try {
      await submitCorrection({ date: correctionDate, requestedInTime: correctionIn || undefined, requestedOutTime: correctionOut || undefined, reason: correctionReason.trim() });
      setCorrectionRequests(await getCorrectionRequests());
      Alert.alert(m('Taotlus esitatud'), m('Meister või peakasutaja vaatab paranduse üle. Olek ilmub samasse vaatesse.'));
    } catch (error) { Alert.alert(m('Taotlust ei saadetud'), error instanceof Error ? error.message : m('Tundmatu viga')); }
  }

  async function openCorrections() {
    setScreen('correction');
    setCorrectionsLoading(true);
    try {
      setCorrectionRequests(await getCorrectionRequests());
    } catch (error) {
      Alert.alert(m('Taotlusi ei saadud laadida'), error instanceof Error ? error.message : m('Tundmatu viga'));
    } finally {
      setCorrectionsLoading(false);
    }
  }

  async function openTimesheet() {
    setScreen('timesheet');
    setTimesheetLoading(true);
    setTimesheetError(null);
    try {
      setTimesheet(await getTimesheet('2026-07-15', '2026-07-21'));
    } catch (error) {
      setTimesheetError(error instanceof Error ? error.message : 'Tunnilehte ei saadud laadida.');
    } finally {
      setTimesheetLoading(false);
    }
  }

  async function createAccount() {
    if (!phone.trim() || !name.trim()) {
      Alert.alert(m('Andmed puuduvad'), m('Sisesta nimi ja telefoninumber.'));
      return;
    }
    try {
      await registerAccount({ name: name.trim(), phone: phone.trim(), pin });
      setScreen('home');
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'PIN_SETUP_REQUIRED') {
        try {
          const result = await requestPinRecovery(phone.trim());
          if (result.challengeId) {
            setRecoveryChallengeId(result.challengeId);
            setNewPin(pin);
            setScreen('recovery');
            Alert.alert(m('Kood saadetud'), `${m('Kui number on süsteemis olemas, saabub SMS-iga kuuekohaline kood.')}${result.developmentCode ? `\n\nTest code: ${result.developmentCode}` : ''}`);
            return;
          }
        } catch (setupError) {
          Alert.alert(m('Kontot ei loodud'), setupError instanceof Error ? setupError.message : m('Tundmatu viga'));
          return;
        }
      }
      Alert.alert(m('Kontot ei loodud'), error instanceof Error ? error.message : m('Tundmatu viga'));
    }
  }

  async function sendRecoveryCode() {
    if (!phone.trim()) return Alert.alert(m('Telefoninumber puudub'), m('Sisesta oma telefoninumber.'));
    setRecoveryLoading(true);
    try {
      const result = await requestPinRecovery(phone.trim());
      if (result.challengeId) setRecoveryChallengeId(result.challengeId);
      Alert.alert(m('Kood saadetud'), `${m('Kui number on süsteemis olemas, saabub SMS-iga kuuekohaline kood.')}${result.developmentCode ? `\n\nTest code: ${result.developmentCode}` : ''}`);
    } catch (error) {
      Alert.alert(m('Koodi ei saadetud'), error instanceof Error ? error.message : m('Tundmatu viga'));
    } finally {
      setRecoveryLoading(false);
    }
  }

  async function resetPin() {
    if (!recoveryChallengeId) return Alert.alert(m('Küsi esmalt taastamiskood.'));
    if (!/^\d{6}$/.test(recoveryCode)) return Alert.alert(m('Vigane kood'), m('Sisesta SMS-iga saadetud kuuekohaline kood.'));
    if (!/^\d{4,}$/.test(newPin)) return Alert.alert(m('Vigane PIN'), m('Uus PIN peab sisaldama vähemalt nelja numbrit.'));
    setRecoveryLoading(true);
    try {
      await confirmPinRecovery({ challengeId: recoveryChallengeId, code: recoveryCode, newPin });
      setPin(newPin);
      setRecoveryCode('');
      setNewPin('');
      setRecoveryChallengeId(null);
      setScreen('signup');
      Alert.alert(m('PIN muudetud'), m('Uus PIN on salvestatud. Nüüd saad sisse logida.'));
    } catch (error) {
      Alert.alert(m('PIN-i ei muudetud'), error instanceof Error ? error.message : m('Tundmatu viga'));
    } finally {
      setRecoveryLoading(false);
    }
  }

  async function handleCode(data: string) {
    if (scanLockRef.current) return;
    scanLockRef.current = true;
    setScanLocked(true);
    const locationPermission = await Location.requestForegroundPermissionsAsync();
    if (locationPermission.status !== 'granted') {
      Alert.alert(m('Asukoha luba puudub'), m('Töömaale registreerimiseks peab asukohakontroll olema lubatud.'), [
        { text: m('Proovi uuesti'), onPress: () => { scanLockRef.current = false; setScanLocked(false); } },
      ]);
      return;
    }
    let position: Location.LocationObject;
    try {
      position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    } catch {
      Alert.alert(m('Asukohta ei leitud'), m('Kontrolli, et GPS oleks sisse lülitatud, ja proovi uuesti.'), [
        { text: m('Proovi uuesti'), onPress: () => { scanLockRef.current = false; setScanLocked(false); } },
      ]);
      return;
    }
    if (position.mocked) {
      Alert.alert(m('Võltsasukoht tuvastatud'), m('Registreerimist ei salvestatud. Lülita näidisasukoha rakendus välja.'), [
        { text: m('Sulge'), onPress: () => { scanLockRef.current = false; setScanLocked(false); } },
      ]);
      return;
    }
    const accuracy = position.coords.accuracy;
    if (accuracy === null || accuracy > 100) {
      Alert.alert(m('Asukoht pole piisavalt täpne'), m('Liigu avatud alale ja proovi uuesti.'), [
        { text: m('Proovi uuesti'), onPress: () => { scanLockRef.current = false; setScanLocked(false); } },
      ]);
      return;
    }
    const scanInput = {
      clientEventId: `mobile-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      qrPayload: data,
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracyMeters: accuracy,
      mockedLocation: Boolean(position.mocked),
      scannedAt: new Date().toISOString(),
    };
    let result: ScanResult;
    let distanceForMessage = 0;
    try {
      const response = await registerScan(scanInput);
      result = { action: response.action, site: response.siteName, gate: response.gateName };
      distanceForMessage = Math.round(response.distanceMeters);
    } catch (error) {
      if (isNetworkFailure(error)) {
        const count = await queueScan(scanInput);
        setPendingScans(count);
        Alert.alert(m('Salvestatud saatmisjärjekorda'), m('Internetiühendus puudub. QR-kood, GPS ja skaneerimisaeg saadetakse automaatselt ühenduse taastumisel.'), [
          { text: m('Valmis'), onPress: () => { scanLockRef.current = false; setScanLocked(false); setScreen('home'); } },
        ]);
        return;
      }
      Alert.alert(m('Registreerimine ebaõnnestus'), error instanceof Error ? error.message : m('Serveriga ei saadud ühendust.'), [
        { text: m('Proovi uuesti'), onPress: () => { scanLockRef.current = false; setScanLocked(false); } },
      ]);
      return;
    }
    Alert.alert(
      result.action === 'IN' ? m('Sisenemine registreeritud') : m('Väljumine registreeritud'),
      `${result.site}\n${result.gate} · ${result.action}\n${m('Asukoht kinnitatud')} (${distanceForMessage} m)`,
      [{ text: m('Valmis'), onPress: () => { scanLockRef.current = false; setScanLocked(false); setScreen('home'); } }],
    );
  }

  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics} style={styles.safe}>
    <SafeAreaView style={styles.safe} edges={['top', 'right', 'bottom', 'left']}>
      <StatusBar style="dark" />
      {sessionLoading ? <View style={styles.sessionLoading}><ActivityIndicator color={colors.primary} /><Text style={styles.muted}>{t('checkingLogin')}</Text></View> : <>
      {screen === 'signup' && (
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}><Image source={require('./assets/siteclock-icon.png')} style={styles.brandIcon} /><View><Text style={styles.brandName}>SiteClock</Text><Text style={styles.muted}>{t('workerApp')}</Text></View></View>
          <LanguagePicker language={language} onChange={changeLanguage} label={t('language')} />
          <View style={styles.spacerLarge} />
          <Text style={styles.title}>{t('createAccount')}</Text>
          <Text style={styles.copy}>{t('accountHelp')}</Text>
          <Text style={styles.label}>{t('phone')}</Text>
          <TextInput value={phone} onChangeText={setPhone} keyboardType="phone-pad" style={styles.input} />
          <Text style={styles.label}>{t('fullName')}</Text>
          <TextInput value={name} onChangeText={setName} style={styles.input} />
          <Text style={styles.label}>{t('createPin')}</Text>
          <TextInput value={pin} onChangeText={setPin} secureTextEntry keyboardType="number-pad" style={styles.input} />
          <PrimaryButton label={t('continue')} onPress={createAccount} />
          <Pressable onPress={() => setScreen('recovery')}><Text style={styles.textLink}>{t('forgotPin')}</Text></Pressable>
        </ScrollView>
      )}

      {screen === 'recovery' && (
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}><Image source={require('./assets/siteclock-icon.png')} style={styles.brandIcon} /><View><Text style={styles.brandName}>SiteClock</Text><Text style={styles.muted}>{t('pinRecovery')}</Text></View></View>
          <View style={styles.spacerLarge} />
          <Pressable onPress={() => setScreen('signup')}><Text style={styles.back}>{t('back')}</Text></Pressable>
          <Text style={styles.title}>{t('recoverPin')}</Text>
          <Text style={styles.copy}>{t('recoveryHelp')}</Text>
          <Text style={styles.label}>{t('phone')}</Text>
          <TextInput value={phone} onChangeText={setPhone} keyboardType="phone-pad" editable={!recoveryChallengeId} style={styles.input} />
          {!recoveryChallengeId ? (
            <PrimaryButton label={recoveryLoading ? t('sending') : t('sendCode')} onPress={sendRecoveryCode} />
          ) : (
            <>
              <Text style={styles.label}>{t('smsCode')}</Text>
              <TextInput value={recoveryCode} onChangeText={setRecoveryCode} keyboardType="number-pad" maxLength={6} style={styles.input} />
              <Text style={styles.label}>{t('newPin')}</Text>
              <TextInput value={newPin} onChangeText={setNewPin} secureTextEntry keyboardType="number-pad" style={styles.input} />
              <PrimaryButton label={recoveryLoading ? t('saving') : t('savePin')} onPress={resetPin} />
              <Pressable onPress={() => { setRecoveryChallengeId(null); setRecoveryCode(''); }}><Text style={styles.textLink}>{t('resend')}</Text></Pressable>
            </>
          )}
        </ScrollView>
      )}

      {screen === 'home' && (
        <ScrollView contentContainerStyle={styles.page}>
          <Header name={name} subtitle={t('workerApp')} />
          <LanguagePicker language={language} onChange={changeLanguage} label={t('language')} />
          <View style={styles.card}>
            <View style={styles.rowBetween}><View><Text style={styles.muted}>{t('today')}</Text><Text style={styles.status}>{t('onSite')}</Text></View><Text style={styles.badge}>IN 07:42</Text></View>
            <Text style={styles.bigNumber}>6 h 26 min</Text>
            <Text style={styles.muted}>{t('runningTime')}</Text>
          </View>
          <PrimaryButton label={t('scanQr')} onPress={() => setScreen('scanner')} />
          <SecondaryButton label={t('timesheet')} onPress={openTimesheet} />
          <SecondaryButton label={`${t('notifications')}${notifications.some((item) => !item.readAt) ? ` (${notifications.filter((item) => !item.readAt).length})` : ''}`} onPress={openNotifications} />
          <Pressable onPress={confirmLogout}><Text style={styles.textLink}>{t('logout')}</Text></Pressable>
          {pendingScans > 0 && <View style={styles.queueCard}><View style={styles.grow}><Text style={styles.queueTitle}>{pendingScans} {t('pendingSync')}</Text><Text style={styles.muted}>{syncError ? `Viimane vastus: ${syncError}` : t('autoSync')}</Text></View><View><Pressable onPress={() => syncQueue(true)}><Text style={styles.syncLink}>{t('sendNow')}</Text></Pressable>{syncError && <Pressable onPress={discardFailedScan}><Text style={styles.discardLink}>{t('remove')}</Text></Pressable>}</View></View>}
          <Text style={styles.sectionTitle}>{t('recent')}</Text>
          <Event title="Kesklinna ehitus" detail="Peavärav · IN" time="07:42" />
          <Event title="Kesklinna ehitus" detail="Peavärav · OUT" time="17:01" />
          <Event title="Kesklinna ehitus" detail="Peavärav · IN" time="08:03" />
        </ScrollView>
      )}

      {screen === 'scanner' && (
        <View style={styles.scannerPage}>
          <View style={styles.scannerHeader}><Pressable onPress={() => setScreen('home')}><Text style={styles.back}>{t('back')}</Text></Pressable><Text style={styles.scannerTitle}>{t('scannerTitle')}</Text><View style={styles.headerSpace} /></View>
          {!permission?.granted ? (
            <View style={styles.permission}><Text style={styles.title}>{t('cameraPermission')}</Text><Text style={styles.copy}>{t('cameraHelp')}</Text><PrimaryButton label={t('allowCamera')} onPress={requestPermission} /></View>
          ) : (
            <CameraView style={styles.camera} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={({ data }) => handleCode(data)}>
              <View style={styles.scanFrame} />
              <Text style={styles.cameraHint}>{t('scannerHint')}</Text>
            </CameraView>
          )}
        </View>
      )}

      {screen === 'timesheet' && (
        <ScrollView contentContainerStyle={styles.page}>
          <Header name={name} subtitle={t('workerApp')} />
          <View style={styles.rowBetween}><Pressable onPress={() => setScreen('home')}><Text style={styles.back}>{t('back')}</Text></Pressable><Text style={styles.sectionTitle}>{t('week')}</Text></View>
          {timesheetLoading ? <View style={styles.loading}><ActivityIndicator color={colors.primary} /><Text style={styles.muted}>{t('loadingTimesheet')}</Text></View> : (
            <>
              <View style={styles.card}><Text style={styles.muted}>{t('weeklyHours')}</Text><Text style={styles.bigNumber}>{formatMinutes(timesheet.reduce((sum, day) => sum + (day.totalMinutes ?? 0), 0), t('incomplete'))}</Text><Text style={styles.muted}>{timesheet.length} {t('workdaysUpdated')}</Text></View>
              {timesheetError ? <View style={styles.errorBox}><Text style={styles.warning}>{timesheetError}</Text><SecondaryButton label={t('retry')} onPress={openTimesheet} /></View> : null}
              {!timesheetError && timesheet.length === 0 ? <View style={styles.empty}><Text style={styles.eventTitle}>{t('noWeekEntries')}</Text><Text style={styles.muted}>{t('noWeekEntriesHelp')}</Text></View> : null}
              {timesheet.map((day) => <Day key={`${day.date}-${day.siteName}`} day={day} language={language} incomplete={t('incomplete')} missing={t('missing')} />)}
            </>
          )}
          <SecondaryButton label={t('corrections')} onPress={openCorrections} />
        </ScrollView>
      )}

      {screen === 'correction' && (
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
          <Header name={name} subtitle={t('workerApp')} />
          <Pressable onPress={() => setScreen('timesheet')}><Text style={styles.back}>{t('backTimesheet')}</Text></Pressable>
          <Text style={styles.sectionTitle}>{t('correction')}</Text>
          <Text style={styles.copy}>{t('correctionHelp')}</Text>
          <Text style={styles.label}>{t('date')}</Text><TextInput value={correctionDate} onChangeText={setCorrectionDate} placeholder="YYYY-MM-DD" style={styles.input} />
          <Text style={styles.label}>{t('requestedIn')}</Text><TextInput value={correctionIn} onChangeText={setCorrectionIn} placeholder="HH:MM" style={styles.input} />
          <Text style={styles.label}>{t('requestedOut')}</Text><TextInput value={correctionOut} onChangeText={setCorrectionOut} placeholder="HH:MM" style={styles.input} />
          <Text style={styles.label}>{t('reason')}</Text><TextInput value={correctionReason} onChangeText={setCorrectionReason} multiline numberOfLines={4} textAlignVertical="top" style={[styles.input, styles.textarea]} />
          <PrimaryButton label={t('submitCorrection')} onPress={sendCorrection} />
          <Text style={styles.sectionTitle}>{t('previousRequests')}</Text>
          {correctionsLoading ? <ActivityIndicator color={colors.primary} /> : correctionRequests.length === 0 ? <Text style={styles.muted}>{t('noRequests')}</Text> : correctionRequests.map((request) => <CorrectionCard key={request.id} request={request} language={language} t={t} />)}
        </ScrollView>
      )}
      {screen === 'notifications' && (
        <ScrollView contentContainerStyle={styles.page}>
          <Header name={name} subtitle={t('workerApp')} />
          <Pressable onPress={() => setScreen('home')}><Text style={styles.back}>{t('back')}</Text></Pressable>
          <Text style={styles.sectionTitle}>{t('notifications')}</Text>
          {notifications.length === 0 ? <View style={styles.empty}><Text style={styles.eventTitle}>{t('noNotifications')}</Text></View> : notifications.map((notification) => { const localized = localizedNotification(notification, t); return <Pressable key={notification.id} onPress={() => readNotification(notification)} style={[styles.notificationCard, !notification.readAt && styles.notificationUnread]}><View style={styles.rowBetween}><Text style={styles.eventTitle}>{localized.title}</Text>{!notification.readAt && <View style={styles.unreadDot} />}</View><Text style={styles.copy}>{localized.message}</Text><Text style={styles.muted}>{new Date(notification.createdAt).toLocaleString(localeFor(language))}</Text></Pressable>; })}
        </ScrollView>
      )}
      </>}
    </SafeAreaView>
    </SafeAreaProvider>
  );
}

function Header({ name, subtitle }: { name: string; subtitle: string }) {
  const initials = name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  return <View style={styles.header}><View style={styles.brand}><Image source={require('./assets/siteclock-icon.png')} style={styles.brandIcon} /><View><Text style={styles.brandName}>SiteClock</Text><Text style={styles.muted}>{subtitle}</Text></View></View><View style={styles.avatar}><Text style={styles.avatarText}>{initials}</Text></View></View>;
}

function LanguagePicker({ language, onChange, label }: { language: Language; onChange: (language: Language) => void | Promise<void>; label: string }) {
  return <View style={styles.languageRow}><Text style={styles.languageLabel}>{label}</Text>{(['et', 'fi', 'en'] as Language[]).map((code) => <Pressable key={code} onPress={() => onChange(code)} style={[styles.languageChoice, language === code && styles.languageChoiceActive]}><Text style={[styles.languageChoiceText, language === code && styles.languageChoiceTextActive]}>{code.toUpperCase()}</Text></Pressable>)}</View>;
}

function PrimaryButton({ label, onPress }: { label: string; onPress: () => void | Promise<unknown> }) {
  return <Pressable style={({ pressed }) => [styles.button, styles.primaryButton, pressed && styles.pressed]} onPress={onPress}><Text style={styles.primaryButtonText}>{label}</Text></Pressable>;
}

function SecondaryButton({ label, onPress }: { label: string; onPress: () => void | Promise<unknown> }) {
  return <Pressable style={({ pressed }) => [styles.button, styles.secondaryButton, pressed && styles.pressed]} onPress={onPress}><Text style={styles.secondaryButtonText}>{label}</Text></Pressable>;
}

function Event({ title, detail, time }: { title: string; detail: string; time: string }) {
  return <View style={styles.event}><View style={styles.eventIcon}><Text>↔</Text></View><View style={styles.grow}><Text style={styles.eventTitle}>{title}</Text><Text style={styles.muted}>{detail}</Text></View><Text style={styles.eventTime}>{time}</Text></View>;
}

function formatMinutes(minutes: number | null, incomplete = 'Pooleli') {
  if (minutes === null) return incomplete;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function localeFor(language: Language) { return language === 'fi' ? 'fi-FI' : language === 'en' ? 'en-GB' : 'et-EE'; }

function formatDate(date: string, language: Language) {
  return new Intl.DateTimeFormat(localeFor(language), { weekday: 'short', day: 'numeric', month: 'long' }).format(new Date(`${date}T12:00:00`));
}

function Day({ day, language, incomplete, missing }: { day: TimesheetDay; language: Language; incomplete: string; missing: string }) {
  return <View style={styles.day}><View style={styles.rowBetween}><Text style={styles.eventTitle}>{formatDate(day.date, language)}</Text><Text style={styles.eventTime}>{formatMinutes(day.totalMinutes, incomplete)}</Text></View><Text style={styles.muted}>{day.siteName}</Text><Text style={styles.dayTimes}>IN {day.inTime}   →   <Text style={day.outTime === null ? styles.warning : undefined}>OUT {day.outTime ?? missing}</Text></Text></View>;
}

function CorrectionCard({ request, language, t }: { request: CorrectionRequest; language: Language; t: (key: TranslationKey) => string }) {
  const label = request.status === 'PENDING' ? t('pending') : request.status === 'APPROVED' ? t('approved') : t('rejected');
  return <View style={styles.correctionCard}><View style={styles.rowBetween}><Text style={styles.eventTitle}>{formatDate(request.date, language)}</Text><Text style={[styles.correctionStatus, request.status === 'APPROVED' ? styles.correctionApproved : request.status === 'REJECTED' ? styles.correctionRejected : styles.correctionPending]}>{label}</Text></View><Text style={styles.muted}>{request.siteName || t('siteUnknown')} · IN {request.requestedInTime ?? '—'} · OUT {request.requestedOutTime ?? '—'}</Text><Text style={styles.correctionReason}>{request.reason}</Text>{request.decisionNote ? <Text style={styles.decisionText}>{t('managerNote')} {request.decisionNote}</Text> : null}{request.decidedAt ? <Text style={styles.muted}>{t('decided')} {new Date(request.decidedAt).toLocaleString(localeFor(language))}</Text> : null}</View>;
}

function localizedNotification(notification: WorkerNotification, t: (key: TranslationKey) => string) {
  if (notification.type === 'CORRECTION_APPROVED') return { title: t('correctionApprovedTitle'), message: t('correctionApprovedMessage') };
  if (notification.type === 'CORRECTION_REJECTED') return { title: t('correctionRejectedTitle'), message: t('correctionRejectedMessage') };
  return { title: t('missingOutTitle'), message: t('missingOutMessage') };
}

const colors = { background: '#F3F6FA', surface: '#FFFFFF', text: '#10243E', muted: '#66758A', primary: '#0B1F3A', primarySoft: '#E8EFF7', accent: '#FFC928', border: '#D5DEEA', success: '#18794E', warning: '#B54708' };

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background }, page: { padding: 20, paddingBottom: 40 }, spacerLarge: { height: 48 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 }, brandIcon: { width: 42, height: 42, borderRadius: 12 }, brandName: { color: colors.text, fontSize: 20, fontWeight: '700' },
  title: { color: colors.text, fontSize: 30, fontWeight: '700' }, copy: { color: colors.muted, fontSize: 16, lineHeight: 23, marginTop: 10, marginBottom: 22 }, label: { color: colors.text, fontWeight: '600', marginBottom: 7 },
  input: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13, fontSize: 16, color: colors.text, marginBottom: 16 },
  button: { minHeight: 50, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginTop: 12 }, primaryButton: { backgroundColor: colors.accent }, primaryButtonText: { color: colors.primary, fontSize: 16, fontWeight: '800' }, secondaryButton: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.primary }, secondaryButtonText: { color: colors.primary, fontSize: 16, fontWeight: '700' }, pressed: { opacity: 0.75 },
  textLink: { color: colors.primary, fontSize: 16, fontWeight: '700', textAlign: 'center', marginTop: 22, paddingVertical: 8 },
  languageRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 16, marginBottom: 4 }, languageLabel: { color: colors.muted, marginRight: 4 }, languageChoice: { borderWidth: 1, borderColor: colors.border, borderRadius: 16, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.surface }, languageChoiceActive: { backgroundColor: colors.accent, borderColor: colors.accent }, languageChoiceText: { color: colors.text, fontWeight: '700', fontSize: 12 }, languageChoiceTextActive: { color: colors.primary },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }, avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, avatarText: { color: colors.primary, fontWeight: '700' },
  card: { backgroundColor: colors.surface, borderRadius: 16, padding: 18, borderWidth: 1, borderColor: colors.border, marginBottom: 8 }, rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 }, muted: { color: colors.muted, fontSize: 14 }, status: { color: colors.success, fontSize: 18, fontWeight: '700', marginTop: 5 }, badge: { color: colors.primary, backgroundColor: colors.primarySoft, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20, overflow: 'hidden', fontWeight: '700' }, bigNumber: { color: colors.text, fontSize: 32, fontWeight: '700', marginTop: 22 },
  queueCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, backgroundColor: '#FFF7E8', borderColor: '#EBCB8B', borderWidth: 1, borderRadius: 12, padding: 14, marginTop: 14 }, queueTitle: { color: colors.warning, fontWeight: '700', marginBottom: 4 }, syncLink: { color: colors.primary, fontWeight: '700' },
  discardLink: { color: '#A63522', fontWeight: '700', marginTop: 12 },
  sectionTitle: { color: colors.text, fontSize: 18, fontWeight: '700', marginTop: 24, marginBottom: 10 }, event: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11 }, eventIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' }, grow: { flex: 1 }, eventTitle: { color: colors.text, fontSize: 16, fontWeight: '600' }, eventTime: { color: colors.text, fontWeight: '700' },
  scannerPage: { flex: 1, backgroundColor: colors.background }, scannerHeader: { padding: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, scannerTitle: { color: colors.text, fontSize: 18, fontWeight: '700' }, headerSpace: { width: 55 }, back: { color: colors.primary, fontSize: 16, fontWeight: '600' }, permission: { flex: 1, justifyContent: 'center', padding: 24 }, camera: { flex: 1, alignItems: 'center', justifyContent: 'center' }, scanFrame: { width: 240, height: 240, borderWidth: 3, borderColor: '#FFFFFF', borderRadius: 20 }, cameraHint: { color: '#FFFFFF', backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, marginTop: 24, overflow: 'hidden' },
  day: { paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: colors.border }, dayTimes: { color: colors.text, marginTop: 9, fontSize: 15 }, warning: { color: colors.warning, fontWeight: '700' },
  textarea: { minHeight: 100 },
  correctionCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 14, padding: 15, marginBottom: 12, gap: 8 }, correctionStatus: { borderRadius: 20, overflow: 'hidden', paddingHorizontal: 10, paddingVertical: 5, fontWeight: '700', fontSize: 12 }, correctionPending: { color: '#8A5A00', backgroundColor: '#FFF1C7' }, correctionApproved: { color: colors.success, backgroundColor: '#DDF3E8' }, correctionRejected: { color: '#A63522', backgroundColor: '#FBE5DF' }, correctionReason: { color: colors.text, lineHeight: 20 }, decisionText: { color: colors.primary, backgroundColor: colors.primarySoft, borderRadius: 8, padding: 10 },
  notificationCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 14, padding: 16, marginBottom: 12 }, notificationUnread: { borderColor: colors.accent, backgroundColor: '#FFF9E7' }, unreadDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.accent },
  loading: { minHeight: 240, alignItems: 'center', justifyContent: 'center', gap: 12 }, empty: { paddingVertical: 40, alignItems: 'center', gap: 8 }, errorBox: { paddingVertical: 18 },
  sessionLoading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
});
