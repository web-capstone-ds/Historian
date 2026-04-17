import mqtt from 'mqtt';
const tests = [
  { label: 'historian / historian_dev', user: 'historian',  pw: 'historian_dev' },
  { label: 'anonymous',                  user: undefined,    pw: undefined       },
  { label: 'mes_server / wrong',         user: 'mes_server', pw: 'wrong'         },
];
for (const t of tests) {
  await new Promise((resolve) => {
    const c = mqtt.connect('mqtt://localhost:1883', {
      clientId: 'probe_' + Math.random().toString(36).slice(2, 8),
      username: t.user, password: t.pw,
      clean: true, reconnectPeriod: 0, connectTimeout: 3000,
      protocolVersion: 5,
    });
    let done = false;
    const finish = (msg) => {
      if (done) return;
      done = true;
      console.log(`[${t.label}] ${msg}`);
      c.end(true);
      resolve();
    };
    c.on('connect', () => finish('CONNECTED'));
    c.on('error',   (e) => finish('ERROR ' + (e.code || e.message)));
    c.on('close',   () => finish('CLOSED'));
    setTimeout(() => finish('TIMEOUT'), 3500);
  });
}
