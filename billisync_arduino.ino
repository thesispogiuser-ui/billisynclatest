#include <Wire.h>
#include <LiquidCrystal_I2C.h>

LiquidCrystal_I2C lcd(0x27, 16, 2);
const int buzzerPin = 8;

String inputBuffer = "";
String lastRow1    = "";
String lastRow2    = "";
bool   isBuzzing   = false;

void setup() {
  pinMode(buzzerPin, OUTPUT);
  Serial.begin(9600);
  Serial.setTimeout(50);
  lcd.init();
  lcd.backlight();
  lcdWrite("    BILLISYNC   ", "CHOOSE YOUR TABLE  ");
  Serial.println("READY");
}

void loop() {
  while (Serial.available() > 0) {
    char c = Serial.read();
    if (c == '\n') {
      inputBuffer.trim();
      processMessage(inputBuffer);
      inputBuffer = "";
    } else {
      inputBuffer += c;
    }
  }
}

void lcdWrite(String row1, String row2) {
  while (row1.length() < 16) row1 += " ";
  while (row2.length() < 16) row2 += " ";
  row1 = row1.substring(0, 16);
  row2 = row2.substring(0, 16);
  if (row1 != lastRow1) { lcd.setCursor(0, 0); lcd.print(row1); lastRow1 = row1; }
  if (row2 != lastRow2) { lcd.setCursor(0, 1); lcd.print(row2); lastRow2 = row2; }
}

void processMessage(String msg) {
  if (msg.length() == 0) return;

  if (msg == "IDLE") {
    if (!isBuzzing) lcdWrite("    BILLISYNC   ", "CHOOSE YOUR TABLE  ");

  } else if (msg == "BUZZ") {
    if (isBuzzing) return;
    isBuzzing = true;
    buzz();
    isBuzzing = false;
    lastRow1 = ""; lastRow2 = "";
    lcdWrite("    BILLISYNC   ", "CHOOSE YOUR TABLE");

  } else if (msg.startsWith("TABLE:")) {
    if (isBuzzing) return;
    // FORMAT: TABLE:Table 1:00:50
    int first  = msg.indexOf(':');
    int second = msg.indexOf(':', first + 1);
    String tableName = msg.substring(first + 1, second);
    String timeStr   = msg.substring(second + 1);
    lcdWrite(tableName, "Time: " + timeStr);
  }
}

void buzz() {
  lastRow1 = ""; lastRow2 = "";
  lcdWrite("Session Ended!", "  TIME IS UP! ");
  tone(buzzerPin, 2500, 600); delay(700);
  tone(buzzerPin, 2500, 600); delay(700);
  tone(buzzerPin, 2500, 600); delay(700);
  delay(2000);
}
