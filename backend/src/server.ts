import { app, io } from './app';
import http from 'http';
import { initTradingCron } from './services/trading.engine';
import { initVoiceSockets } from './sockets/voice.socket';

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

io.attach(server);
initTradingCron();
initVoiceSockets(io);

server.listen(PORT, () => {
  console.log(`✅ Texa Backend running on port ${PORT} | Realtime Active | DB Connected`);
});
