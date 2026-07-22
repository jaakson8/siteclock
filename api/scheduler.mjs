export function startScheduler({ runDaily, processEmails }) {
  let dailyTimer;
  let stopped = false;
  const scheduleDaily = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(2, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    dailyTimer = setTimeout(async () => {
      if (stopped) return;
      try {
        await runDaily(new Date());
        await processEmails();
      } catch (error) {
        console.error("Igapäevase automaatika viga:", error);
      } finally {
        if (!stopped) scheduleDaily();
      }
    }, next.getTime() - now.getTime());
  };
  scheduleDaily();
  const emailTimer = setInterval(
    () =>
      processEmails().catch((error) =>
        console.error("E-posti töötluse viga:", error),
      ),
    60_000,
  );
  return () => {
    stopped = true;
    clearTimeout(dailyTimer);
    clearInterval(emailTimer);
  };
}
