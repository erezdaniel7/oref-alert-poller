const path = require("path");
const { Service } = require("node-windows");

const svc = new Service({
    name: "Oref Alert Poller",
    description: "Polls oref.org.il for rocket/alert notifications and sends them to Telegram & WhatsApp.",
    script: path.join(__dirname, "dist", "index.js"),
    nodeOptions: [],
    env: [
        {
            name: "NODE_ENV",
            value: "production",
        },
    ],
});

svc.on("install", () => {
    console.log("Service installed. Starting...");
    svc.start();
});

svc.on("alreadyinstalled", () => {
    console.log("Service is already installed.");
});

svc.on("start", () => {
    console.log("Service started.");
});

svc.install();
