import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Location from "expo-location";

import {
  ApiError,
  NotificationItem,
  ScanResult,
  TimesheetDay,
  Worker,
  fetchNotifications,
  fetchTimesheet,
  loadSession,
  logout as apiLogout,
  registerWorker,
  submitScan,
} from "./src/api";

type Screen = "loading" | "login" | "home" | "scanner" | "timesheet" | "notifications";

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIso(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function randomId(): string {
  return `mob-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [worker, setWorker] = useState<Worker | null>(null);

  // Login form state
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);

  // Scanner state
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(true);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [processingScan, setProcessingScan] = useState(false);
  const lastScannedRef = useRef<string | null>(null);

  // Timesheet
  const [timesheet, setTimesheet] = useState<TimesheetDay[] | null>(null);
  const [timesheetLoading, setTimesheetLoading] = useState(false);

  // Notifications
  const [notifications, setNotifications] = useState<NotificationItem[] | null>(null);

  useEffect(() => {
    (async () => {
      const existing = await loadSession();
      if (existing) {
        setWorker(existing);
        setScreen("home");
      } else {
        setScreen("login");
      }
    })();
  }, []);

  const handleLogin = useCallback(async () => {
    setLoginError(null);
    if (!phone.trim()) {
      setLoginError("Sisesta telefoninumber");
      return;
    }
    if (!/^\d{4,}$/.test(pin)) {
      setLoginError("PIN peab olema vähemalt 4 numbrit");
      return;
    }
    setLoginLoading(true);
    try {
      const result = await registerWorker(phone.trim(), pin);
      setWorker(result);
      setScreen("home");
    } catch (error) {
      if (error instanceof ApiError) {
        setLoginError(error.message);
      } else {
        setLoginError("Ühendus serveriga ebaõnnestus. Kontrolli internetiühendust.");
      }
    } finally {
      setLoginLoading(false);
    }
  }, [phone, pin]);

  const handleLogout = useCallback(async () => {
    if (worker) {
      await apiLogout(worker.accessToken);
    }
    setWorker(null);
    setPhone("");
    setPin("");
    setScreen("login");
  }, [worker]);

  const openScanner = useCallback(async () => {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        Alert.alert(
          "Kaameraluba puudub",
          "SiteClock vajab QR-koodi skaneerimiseks kaamera luba.",
        );
        return;
      }
    }
    setScanResult(null);
    setScanError(null);
    setScanning(true);
    lastScannedRef.current = null;
    setScreen("scanner");
  }, [permission, requestPermission]);

  const handleBarcodeScanned = useCallback(
    async (event: { data: string }) => {
      const rawData = event.data;
      if (!rawData || !scanning || processingScan) return;
      if (lastScannedRef.current === rawData) return;
      lastScannedRef.current = rawData;

      setScanning(false);
      setProcessingScan(true);
      setScanError(null);

      try {
        if (!worker) throw new Error("Sisselogimine puudub");

        const locationPermission = await Location.requestForegroundPermissionsAsync();
        if (!locationPermission.granted) {
          throw new Error("Asukohaluba on registreerimiseks kohustuslik");
        }

        const position = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.High,
        });

        const result = await submitScan(worker.accessToken, {
          qrPayload: rawData,
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: position.coords.accuracy ?? 999,
          scannedAt: new Date().toISOString(),
          clientEventId: randomId(),
          mockedLocation: position.mocked === true,
        });

        setScanResult(result);
      } catch (error) {
        if (error instanceof ApiError) {
          setScanError(error.message);
        } else if (error instanceof Error) {
          setScanError(error.message);
        } else {
          setScanError("Registreerimine ebaõnnestus");
        }
      } finally {
        setProcessingScan(false);
      }
    },
    [scanning, processingScan, worker],
  );

  const retryScan = useCallback(() => {
    setScanResult(null);
    setScanError(null);
    lastScannedRef.current = null;
    setScanning(true);
  }, []);

  const openTimesheet = useCallback(async () => {
    if (!worker) return;
    setScreen("timesheet");
    setTimesheetLoading(true);
    try {
      const data = await fetchTimesheet(
        worker.accessToken,
        daysAgoIso(30),
        isoToday(),
      );
      setTimesheet(data);
    } catch (error) {
      Alert.alert("Viga", "Tunnilehe laadimine ebaõnnestus");
    } finally {
      setTimesheetLoading(false);
    }
  }, [worker]);

  const openNotifications = useCallback(async () => {
    if (!worker) return;
    setScreen("notifications");
    try {
      const data = await fetchNotifications(worker.accessToken);
      setNotifications(data);
    } catch {
      Alert.alert("Viga", "Teavituste laadimine ebaõnnestus");
    }
  }, [worker]);

  if (screen === "loading") {
    return (
      <SafeAreaView style={styles.centered}>
        <ActivityIndicator size="large" color="#1f6f4a" />
      </SafeAreaView>
    );
  }

  if (screen === "login") {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="dark-content" />
        <View style={styles.loginBox}>
          <Text style={styles.logo}>SiteClock</Text>
          <Text style={styles.subtitle}>Töömaa kohaloleku registreerimine</Text>

          <Text style={styles.label}>Telefoninumber</Text>
          <TextInput
            style={styles.input}
            placeholder="+372 5xxx xxxx"
            keyboardType="phone-pad"
            value={phone}
            onChangeText={setPhone}
            autoCapitalize="none"
          />

          <Text style={styles.label}>PIN-kood</Text>
          <TextInput
            style={styles.input}
            placeholder="Vähemalt 4 numbrit"
            keyboardType="number-pad"
            secureTextEntry
            value={pin}
            onChangeText={setPin}
          />

          {loginError ? <Text style={styles.errorText}>{loginError}</Text> : null}

          <TouchableOpacity
            style={styles.primaryButton}
            onPress={handleLogin}
            disabled={loginLoading}
          >
            {loginLoading ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text style={styles.primaryButtonText}>Jätka</Text>
            )}
          </TouchableOpacity>

          <Text style={styles.hint}>
            Kui su andmeid süsteemis ei ole, pöördu töömaa meistri poole.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (screen === "scanner") {
    return (
      <SafeAreaView style={styles.scannerContainer}>
        <StatusBar barStyle="light-content" />
        <View style={styles.scannerHeader}>
          <TouchableOpacity onPress={() => setScreen("home")}>
            <Text style={styles.backLink}>‹ Tagasi</Text>
          </TouchableOpacity>
          <Text style={styles.scannerTitle}>Skaneeri QR-kood</Text>
          <View style={{ width: 60 }} />
        </View>

        <View style={styles.cameraWrapper}>
          {scanning && (
            <CameraView
              style={StyleSheet.absoluteFillObject}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={handleBarcodeScanned}
            />
          )}
          {!scanning && processingScan && (
            <View style={styles.centeredOverlay}>
              <ActivityIndicator size="large" color="#ffffff" />
              <Text style={styles.overlayText}>Kontrollin asukohta ja saadan...</Text>
            </View>
          )}
        </View>

        <Text style={styles.scannerHint}>
          Suuna kaamera IN- või OUT-koodile. Asukohta kontrollitakse registreerimise hetkel.
        </Text>

        <Modal visible={scanResult !== null} transparent animationType="fade">
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>
                {scanResult?.action === "IN" ? "Sisenemine registreeritud" : "Väljumine registreeritud"}
              </Text>
              <Text style={styles.modalLine}>{scanResult?.siteName}</Text>
              <Text style={styles.modalLine}>
                {scanResult?.gateName} · {scanResult?.action}
              </Text>
              <Text style={styles.modalLineMuted}>
                Kell {scanResult ? new Date(scanResult.registeredAt).toLocaleTimeString("et-EE").slice(0, 5) : ""}
              </Text>
              <TouchableOpacity
                style={styles.primaryButton}
                onPress={() => setScreen("home")}
              >
                <Text style={styles.primaryButtonText}>Valmis</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        <Modal visible={scanError !== null} transparent animationType="fade">
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitleError}>Registreerimine ebaõnnestus</Text>
              <Text style={styles.modalLine}>{scanError}</Text>
              <TouchableOpacity style={styles.primaryButton} onPress={retryScan}>
                <Text style={styles.primaryButtonText}>Proovi uuesti</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={() => setScreen("home")}
              >
                <Text style={styles.secondaryButtonText}>Tagasi avalehele</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    );
  }

  if (screen === "timesheet") {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.topBar}>
          <TouchableOpacity onPress={() => setScreen("home")}>
            <Text style={styles.backLink}>‹ Tagasi</Text>
          </TouchableOpacity>
          <Text style={styles.topBarTitle}>Tunnileht</Text>
          <View style={{ width: 60 }} />
        </View>
        {timesheetLoading ? (
          <ActivityIndicator style={{ marginTop: 32 }} />
        ) : (
          <ScrollView style={styles.list}>
            {(timesheet ?? []).length === 0 && (
              <Text style={styles.hint}>Registreeringuid ei leitud.</Text>
            )}
            {(timesheet ?? []).map((day) => (
              <View key={day.date} style={styles.listRow}>
                <Text style={styles.listRowDate}>{day.date}</Text>
                <Text style={styles.listRowSite}>{day.siteName}</Text>
                <Text style={styles.listRowTimes}>
                  IN {day.inTime ?? "—"} · OUT {day.outTime ?? "—"}
                  {day.totalMinutes != null
                    ? ` · ${(day.totalMinutes / 60).toFixed(1)} h`
                    : ""}
                </Text>
                {!day.outTime && day.inTime && (
                  <Text style={styles.warningText}>
                    OUT-registreering puudub. Esita parandustaotlus.
                  </Text>
                )}
              </View>
            ))}
          </ScrollView>
        )}
      </SafeAreaView>
    );
  }

  if (screen === "notifications") {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.topBar}>
          <TouchableOpacity onPress={() => setScreen("home")}>
            <Text style={styles.backLink}>‹ Tagasi</Text>
          </TouchableOpacity>
          <Text style={styles.topBarTitle}>Teavitused</Text>
          <View style={{ width: 60 }} />
        </View>
        <ScrollView style={styles.list}>
          {(notifications ?? []).length === 0 && (
            <Text style={styles.hint}>Teavitusi pole.</Text>
          )}
          {(notifications ?? []).map((item) => (
            <View
              key={item.id}
              style={[styles.listRow, !item.readAt && styles.listRowUnread]}
            >
              <Text style={styles.listRowDate}>{item.title}</Text>
              <Text style={styles.listRowSite}>{item.message}</Text>
            </View>
          ))}
        </ScrollView>
      </SafeAreaView>
    );
  }

  // Home screen
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.homeHeader}>
        <Text style={styles.logo}>SiteClock</Text>
        <TouchableOpacity onPress={handleLogout}>
          <Text style={styles.logoutLink}>Logi välja</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.greeting}>Tere, {worker?.name ?? ""}</Text>

      <TouchableOpacity style={styles.scanButton} onPress={openScanner}>
        <Text style={styles.scanButtonText}>Skaneeri QR-kood</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.secondaryTile} onPress={openTimesheet}>
        <Text style={styles.secondaryTileText}>Tunnileht</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.secondaryTile} onPress={openNotifications}>
        <Text style={styles.secondaryTileText}>Teavitused</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ffffff",
  },
  loginBox: {
    flex: 1,
    padding: 24,
    justifyContent: "center",
  },
  logo: {
    fontSize: 28,
    fontWeight: "700",
    color: "#1f2d24",
    textAlign: "center",
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: "#5b6a60",
    textAlign: "center",
    marginBottom: 32,
  },
  label: {
    fontSize: 13,
    color: "#3a463e",
    marginBottom: 6,
    marginTop: 16,
  },
  input: {
    borderWidth: 1,
    borderColor: "#c7d1cb",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  errorText: {
    color: "#b3261e",
    marginTop: 12,
    fontSize: 13,
  },
  primaryButton: {
    backgroundColor: "#1f6f4a",
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 24,
  },
  primaryButtonText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "600",
  },
  secondaryButton: {
    marginTop: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  secondaryButtonText: {
    color: "#1f6f4a",
    fontSize: 14,
  },
  hint: {
    fontSize: 12,
    color: "#8a958e",
    textAlign: "center",
    marginTop: 20,
    paddingHorizontal: 12,
  },
  scannerContainer: {
    flex: 1,
    backgroundColor: "#0e1712",
  },
  scannerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  scannerTitle: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "600",
  },
  backLink: {
    color: "#8fd4b0",
    fontSize: 15,
  },
  cameraWrapper: {
    flex: 1,
    marginHorizontal: 16,
    borderRadius: 16,
    overflow: "hidden",
  },
  centeredOverlay: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  overlayText: {
    color: "#ffffff",
    marginTop: 12,
  },
  scannerHint: {
    color: "#c4d0c9",
    fontSize: 13,
    textAlign: "center",
    paddingHorizontal: 24,
    paddingVertical: 16,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  modalCard: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 24,
    width: "85%",
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#1f2d24",
    marginBottom: 12,
  },
  modalTitleError: {
    fontSize: 18,
    fontWeight: "700",
    color: "#b3261e",
    marginBottom: 12,
  },
  modalLine: {
    fontSize: 15,
    color: "#3a463e",
    marginBottom: 4,
  },
  modalLineMuted: {
    fontSize: 13,
    color: "#8a958e",
    marginTop: 4,
    marginBottom: 12,
  },
  homeHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  logoutLink: {
    color: "#8a958e",
    fontSize: 14,
  },
  greeting: {
    fontSize: 18,
    color: "#1f2d24",
    marginTop: 24,
    marginHorizontal: 20,
    marginBottom: 24,
  },
  scanButton: {
    backgroundColor: "#1f6f4a",
    borderRadius: 16,
    marginHorizontal: 20,
    paddingVertical: 28,
    alignItems: "center",
    marginBottom: 16,
  },
  scanButtonText: {
    color: "#ffffff",
    fontSize: 18,
    fontWeight: "700",
  },
  secondaryTile: {
    borderWidth: 1,
    borderColor: "#dce3de",
    borderRadius: 12,
    marginHorizontal: 20,
    paddingVertical: 16,
    alignItems: "center",
    marginBottom: 12,
  },
  secondaryTileText: {
    color: "#1f2d24",
    fontSize: 15,
    fontWeight: "600",
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#eef1ef",
  },
  topBarTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#1f2d24",
  },
  list: {
    flex: 1,
    padding: 16,
  },
  listRow: {
    borderWidth: 1,
    borderColor: "#eef1ef",
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
  },
  listRowUnread: {
    borderColor: "#1f6f4a",
    backgroundColor: "#f2f8f4",
  },
  listRowDate: {
    fontSize: 15,
    fontWeight: "600",
    color: "#1f2d24",
  },
  listRowSite: {
    fontSize: 13,
    color: "#5b6a60",
    marginTop: 2,
  },
  listRowTimes: {
    fontSize: 13,
    color: "#3a463e",
    marginTop: 6,
  },
  warningText: {
    fontSize: 12,
    color: "#b3261e",
    marginTop: 6,
  },
});
