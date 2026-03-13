const path = require("path");
const { Service } = require("node-windows");

const svc = new Service({
    name: "Oref Alert Poller",
    description: "Polls oref.org.il for rocket/alert notifications and sends them to Telegram & WhatsApp.",
    script: path.join(__dirname, "dist", "index.js"),
});

svc.on("uninstall", () => {
    console.log("Service uninstalled.");
});

svc.on("invalidinstallation", () => {
    console.log("Service is not installed.");
});

svc.uninstall();
