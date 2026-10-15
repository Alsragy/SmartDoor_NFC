const mqtt = require("mqtt");

const BROKER_URL = "mqtt://broker.hivemq.com";
const TOPIC = "jaliko/smart-energy/energy/data";

const client = mqtt.connect(BROKER_URL, {
  connectTimeout: 10_000,
  reconnectPeriod: 2_000,
});

client.on("connect", () => {
  console.log("✅ Subscriber connected:", BROKER_URL);

  client.subscribe(TOPIC, (err) => {
    if (err) {
      console.error("❌ Subscribe error:", err.message);
    } else {
      console.log("👂 Listening on topic:", TOPIC);
    }
  });
});

client.on("message", (topic, message) => {
  console.log("📥 Received:", message.toString());
});

client.on("error", (err) => console.error("❌ MQTT error:", err.message));

