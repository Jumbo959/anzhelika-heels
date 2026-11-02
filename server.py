# -*- coding: utf-8 -*-
"""Локальный сайт Анжелики: запись, календарь и кабинет."""
import base64
import hashlib
import hmac
import json
import mimetypes
import os
import re
import threading
import uuid
import webbrowser
import zipfile
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from urllib.parse import unquote, urlparse
from xml.sax.saxutils import escape

mimetypes.add_type("text/css", ".css")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("image/webp", ".webp")

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
UPLOADS = os.path.join(ROOT, "uploads")
PORT = 8765


def load_secret():
    path = os.path.join(DATA, "admin.local.json")
    if not os.path.exists(path):
        return "", ""
    with open(path, encoding="utf-8-sig") as handle:
        saved = json.load(handle)
    return str(saved.get("name") or ""), str(saved.get("phone") or "")


SECRET_NAME, SECRET_PHONE = load_secret()
ADMIN_TOKEN = hashlib.sha256(f"{SECRET_NAME}|{SECRET_PHONE}".encode("utf-8")).hexdigest()
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SLOTS = {"hero", "about", "p0", "p1", "p2", "p3", "p4", "p5"}

os.makedirs(DATA, exist_ok=True)
os.makedirs(UPLOADS, exist_ok=True)


def load_json(name, default):
    path = os.path.join(DATA, name)
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8-sig") as handle:
        return json.load(handle)


def save_json(name, payload):
    path = os.path.join(DATA, name)
    temp = path + ".tmp"
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    os.replace(temp, path)


def norm_phone(value):
    raw = "".join(ch for ch in str(value or "") if ch.isdigit() or ch == "+")
    if raw.startswith("8") and len(raw) == 11:
        raw = "+7" + raw[1:]
    elif raw.startswith("7") and len(raw) == 11:
        raw = "+" + raw
    elif raw.startswith("9") and len(raw) == 10:
        raw = "+7" + raw
    return raw


def clean(value, limit):
    text = " ".join(str(value or "").split())
    return text[:limit]


def valid_date(value):
    if not isinstance(value, str) or not DATE_RE.match(value):
        return False
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        return False
    return True


def number(value):
    if isinstance(value, bool) or value is None or value == "":
        raise ValueError("Нужно число")
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("Нужно число") from exc
    if parsed < 0 or parsed > 1_000_000:
        raise ValueError("Сумма вне допустимого диапазона")
    return int(parsed) if parsed.is_integer() else round(parsed, 2)


def counts_by_date(leads):
    counts = {}
    for lead in leads:
        day = lead.get("date")
        if day:
            counts[day] = counts.get(day, 0) + 1
    return counts


def public_state():
    site = load_json("site.json", {})
    leads = load_json("leads.json", [])
    return {
        "phone": site.get("phone", SECRET_PHONE),
        "phoneDisplay": site.get("phoneDisplay", ""),
        "location": site.get("location", ""),
        "capacity": int(site.get("capacity") or 8),
        "daysOff": site.get("daysOff") or [],
        "trialPrice": site.get("trialPrice", 0),
        "privatePrice": site.get("privatePrice", 0),
        "photoVersion": site.get("photoVersion", 1),
        "theme": site.get("theme") or {},
        "photos": site.get("photos") or {},
        "courses": site.get("courses") or [],
        "counts": counts_by_date(leads),
    }


def col_name(index):
    name = ""
    while index:
        index, rem = divmod(index - 1, 26)
        name = chr(65 + rem) + name
    return name


def cell(row, col, value, numeric=False):
    ref = f"{col_name(col)}{row}"
    if numeric and value != "":
        return f'<c r="{ref}"><v>{value}</v></c>'
    return f'<c r="{ref}" t="inlineStr"><is><t>{escape(str(value))}</t></is></c>'


def sheet_xml(rows):
    body = []
    for r_index, row in enumerate(rows, start=1):
        cells = "".join(
            cell(r_index, c_index, value, numeric=isinstance(value, (int, float)) and not isinstance(value, bool))
            for c_index, value in enumerate(row, start=1)
        )
        body.append(f'<row r="{r_index}">{cells}</row>')
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f"<sheetData>{''.join(body)}</sheetData></worksheet>"
    )


def build_xlsx():
    leads = load_json("leads.json", [])
    finance = load_json("finance.json", [])
    site = load_json("site.json", {})
    courses = {item.get("id"): item.get("title") for item in site.get("courses") or []}
    lead_rows = [["Имя", "Телефон", "Дата", "Направление", "Комментарий", "Оставлено"]]
    for lead in leads:
        lead_rows.append([
            lead.get("name", ""),
            lead.get("phone", ""),
            lead.get("date") or "без даты",
            courses.get(lead.get("courseId"), ""),
            lead.get("comment", ""),
            lead.get("createdAt", ""),
        ])
    money_rows = [[
        "Дата", "Направление", "Пришло", "Цена", "Выручка", "Аренда", "Прочие затраты", "Прибыль", "Комментарий",
    ]]
    people_sum = revenue_sum = rent_sum = extra_sum = profit_sum = 0
    for row in finance:
        money_rows.append([
            row.get("date", ""),
            courses.get(row.get("courseId"), row.get("courseTitle", "")),
            row.get("people", 0),
            row.get("price", 0),
            row.get("revenue", 0),
            row.get("rent", 0),
            row.get("extra", 0),
            row.get("profit", 0),
            row.get("note", ""),
        ])
        people_sum += row.get("people") or 0
        revenue_sum += row.get("revenue") or 0
        rent_sum += row.get("rent") or 0
        extra_sum += row.get("extra") or 0
        profit_sum += row.get("profit") or 0
    money_rows.append([])
    money_rows.append(["Итого", "", people_sum, "", revenue_sum, rent_sum, extra_sum, profit_sum, ""])
    blob = BytesIO()
    with zipfile.ZipFile(blob, "w", compression=zipfile.ZIP_DEFLATED) as book:
        book.writestr("[Content_Types].xml", """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>""")
        book.writestr("_rels/.rels", """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>""")
        book.writestr("xl/_rels/workbook.xml.rels", """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>""")
        book.writestr("xl/workbook.xml", """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
<sheet name="Заявки" sheetId="1" r:id="rId1"/>
<sheet name="Касса" sheetId="2" r:id="rId2"/>
</sheets>
</workbook>""")
        book.writestr("xl/worksheets/sheet1.xml", sheet_xml(lead_rows))
        book.writestr("xl/worksheets/sheet2.xml", sheet_xml(money_rows))
    data = blob.getvalue()
    with open(os.path.join(DATA, "kassa.xlsx"), "wb") as handle:
        handle.write(data)
    return data


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def send_json(self, payload, status=200):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 8_000_000:
            raise ValueError("Файл слишком большой")
        raw = self.rfile.read(length) if length else b"{}"
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def admin_ok(self):
        token = self.headers.get("X-Admin-Token") or ""
        return hmac.compare_digest(token, ADMIN_TOKEN)

    def require_admin(self):
        if self.admin_ok():
            return True
        self.send_json({"error": "Нет доступа"}, 401)
        return False

    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        try:
            if path == "/api/state":
                self.send_json(public_state())
                return
            if path == "/api/admin/data":
                if not self.require_admin():
                    return
                self.send_json({
                    "site": load_json("site.json", {}),
                    "leads": load_json("leads.json", []),
                    "finance": load_json("finance.json", []),
                })
                return
            if path == "/api/admin/excel":
                if not self.require_admin():
                    return
                data = build_xlsx()
                self.send_response(200)
                self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
                self.send_header("Content-Disposition", "attachment; filename*=UTF-8''%D0%9A%D0%B0%D1%81%D1%81%D0%B0.xlsx")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            self.serve_static(path)
        except Exception as exc:
            self.send_json({"error": str(exc)}, 500)

    def do_POST(self):
        path = unquote(urlparse(self.path).path)
        try:
            body = self.read_body()
            if path == "/api/lead":
                self.handle_lead(body)
                return
            if path == "/api/book":
                self.handle_book(body)
                return
            if not self.require_admin():
                return
            if path == "/api/admin/settings":
                self.handle_settings(body)
                return
            if path == "/api/admin/photo":
                self.handle_photo(body)
                return
            if path == "/api/admin/lead":
                self.handle_lead_admin(body)
                return
            if path == "/api/admin/finance":
                self.handle_finance(body)
                return
            self.send_json({"error": "Неизвестный запрос"}, 404)
        except ValueError as exc:
            self.send_json({"error": str(exc)}, 400)
        except json.JSONDecodeError:
            self.send_json({"error": "Некорректные данные"}, 400)
        except Exception as exc:
            self.send_json({"error": str(exc)}, 500)

    def handle_lead(self, body):
        name = str(body.get("name") or "").strip()
        phone = norm_phone(body.get("phone"))
        if name == SECRET_NAME and phone == SECRET_PHONE:
            self.send_json({"admin": True, "token": ADMIN_TOKEN})
            return
        if len(name) < 2:
            raise ValueError("Напишите имя")
        if len(phone) < 12:
            raise ValueError("Проверьте номер телефона")
        leads = load_json("leads.json", [])
        lead = {
            "id": uuid.uuid4().hex[:12],
            "name": clean(name, 80),
            "phone": phone,
            "comment": clean(body.get("comment"), 1000),
            "date": None,
            "courseId": None,
            "createdAt": datetime.now().strftime("%Y-%m-%d %H:%M"),
        }
        leads.append(lead)
        save_json("leads.json", leads)
        self.send_json({"ok": True, "id": lead["id"]})

    def handle_book(self, body):
        lead_id = str(body.get("id") or "")
        day = body.get("date")
        course_id = str(body.get("courseId") or "")
        if not valid_date(day):
            raise ValueError("Выберите дату")
        if day < datetime.now().strftime("%Y-%m-%d"):
            raise ValueError("Эта дата уже прошла")
        site = load_json("site.json", {})
        if day in (site.get("daysOff") or []):
            raise ValueError("В этот день выходной")
        course = next((item for item in site.get("courses") or [] if item.get("id") == course_id), None)
        if not course or course.get("status") != "open":
            raise ValueError("Это направление пока нельзя выбрать")
        leads = load_json("leads.json", [])
        taken = sum(1 for item in leads if item.get("date") == day and item.get("id") != lead_id)
        capacity = int(site.get("capacity") or 8)
        if taken >= capacity:
            raise ValueError("На эту дату мест больше нет")
        for lead in leads:
            if lead.get("id") == lead_id:
                lead["date"] = day
                lead["courseId"] = course_id
                if body.get("comment") is not None:
                    lead["comment"] = clean(body.get("comment"), 1000)
                save_json("leads.json", leads)
                self.send_json({"ok": True})
                return
        raise ValueError("Заявка не найдена. Оставьте номер ещё раз")

    def handle_settings(self, body):
        site = load_json("site.json", {})
        if isinstance(body.get("theme"), dict):
            theme = site.setdefault("theme", {})
            for key in ("bg", "bg2", "text", "muted", "accent"):
                value = str(body["theme"].get(key) or "")
                if re.fullmatch(r"#[0-9a-fA-F]{6}", value):
                    theme[key] = value.lower()
        if "capacity" in body:
            capacity = int(number(body.get("capacity")))
            if capacity < 1 or capacity > 100:
                raise ValueError("Вместимость от 1 до 100")
            site["capacity"] = capacity
        if "daysOff" in body:
            days = body.get("daysOff") or []
            if not isinstance(days, list) or any(not valid_date(day) for day in days):
                raise ValueError("Некорректная дата выходного")
            site["daysOff"] = sorted(set(days))
        if "trialPrice" in body:
            site["trialPrice"] = number(body.get("trialPrice"))
        if "privatePrice" in body:
            site["privatePrice"] = number(body.get("privatePrice"))
        if "phoneDisplay" in body:
            site["phoneDisplay"] = clean(body.get("phoneDisplay"), 40)
        if "location" in body:
            site["location"] = clean(body.get("location"), 180)
        if "courses" in body:
            site["courses"] = self.clean_courses(body.get("courses"))
        save_json("site.json", site)
        self.send_json({"ok": True, "state": public_state()})

    def clean_courses(self, courses):
        if not isinstance(courses, list) or len(courses) > 24:
            raise ValueError("Проверьте список направлений")
        cleaned = []
        seen = set()
        for item in courses:
            title = clean(item.get("title"), 60)
            if len(title) < 2:
                raise ValueError("У направления нужно название")
            course_id = re.sub(r"[^a-z0-9-]", "", str(item.get("id") or "").lower()) or uuid.uuid4().hex[:8]
            if course_id in seen:
                course_id = uuid.uuid4().hex[:8]
            seen.add(course_id)
            status = item.get("status") if item.get("status") in ("open", "soon") else "open"
            cleaned.append({
                "id": course_id,
                "title": title,
                "status": status,
                "duration": clean(item.get("duration") or "60 минут", 40),
                "level": clean(item.get("level") or "", 80),
                "price": number(item.get("price") if item.get("price") not in ("", None) else 0),
                "summary": clean(item.get("summary"), 400),
            })
        return cleaned

    def handle_photo(self, body):
        slot = str(body.get("slot") or "")
        if slot not in SLOTS:
            raise ValueError("Неизвестное место для фото")
        site = load_json("site.json", {})
        photos = site.setdefault("photos", {})
        if body.get("clear"):
            self.remove_slot(slot)
            photos[slot] = ""
        else:
            name = str(body.get("name") or "photo.jpg")
            ext = os.path.splitext(name)[1].lower()
            if ext == ".jpeg":
                ext = ".jpg"
            if ext not in (".jpg", ".png", ".webp", ".gif"):
                raise ValueError("Нужна фотография jpg, png или webp")
            raw = base64.b64decode(body.get("data") or "")
            if len(raw) > 5_000_000:
                raise ValueError("Фото больше 5 МБ")
            self.remove_slot(slot)
            with open(os.path.join(UPLOADS, slot + ext), "wb") as handle:
                handle.write(raw)
            photos[slot] = f"/uploads/{slot}{ext}"
        site["photoVersion"] = int(site.get("photoVersion") or 1) + 1
        save_json("site.json", site)
        self.send_json({"ok": True, "state": public_state()})

    def remove_slot(self, slot):
        for name in os.listdir(UPLOADS):
            if os.path.splitext(name)[0] == slot:
                os.remove(os.path.join(UPLOADS, name))

    def handle_lead_admin(self, body):
        leads = load_json("leads.json", [])
        lead_id = str(body.get("id") or "")
        if body.get("delete"):
            leads = [item for item in leads if item.get("id") != lead_id]
            save_json("leads.json", leads)
            self.send_json({"ok": True})
            return
        for lead in leads:
            if lead.get("id") != lead_id:
                continue
            if "name" in body:
                lead["name"] = clean(body.get("name"), 80)
            if "phone" in body:
                lead["phone"] = norm_phone(body.get("phone"))
            if "comment" in body:
                lead["comment"] = clean(body.get("comment"), 1000)
            if "courseId" in body:
                lead["courseId"] = str(body.get("courseId") or "") or None
            if "date" in body:
                day = body.get("date") or None
                if day and not valid_date(day):
                    raise ValueError("Некорректная дата")
                lead["date"] = day
            save_json("leads.json", leads)
            self.send_json({"ok": True})
            return
        raise ValueError("Заявка не найдена")

    def handle_finance(self, body):
        finance = load_json("finance.json", [])
        if body.get("delete"):
            finance = [item for item in finance if item.get("id") != body.get("id")]
            save_json("finance.json", finance)
            build_xlsx()
            self.send_json({"ok": True, "finance": finance})
            return
        if body.get("people") in ("", None) or body.get("rent") in ("", None):
            raise ValueError("Сначала укажите, сколько человек пришло и сколько стоила аренда")
        people = int(number(body.get("people")))
        rent = number(body.get("rent"))
        price = number(body.get("price") if body.get("price") not in ("", None) else 0)
        extra = number(body.get("extra") if body.get("extra") not in ("", None) else 0)
        if not valid_date(body.get("date")):
            raise ValueError("Укажите дату занятия")
        revenue = round(people * price, 2)
        row = {
            "id": uuid.uuid4().hex[:12],
            "date": body.get("date"),
            "courseId": str(body.get("courseId") or ""),
            "courseTitle": clean(body.get("courseTitle"), 60),
            "people": people,
            "price": price,
            "rent": rent,
            "extra": extra,
            "revenue": revenue,
            "profit": round(revenue - rent - extra, 2),
            "note": clean(body.get("note"), 300),
            "createdAt": datetime.now().strftime("%Y-%m-%d %H:%M"),
        }
        finance.append(row)
        save_json("finance.json", finance)
        build_xlsx()
        self.send_json({"ok": True, "row": row, "finance": finance})

    def serve_static(self, path):
        relative = "index.html" if path in ("", "/") else path.lstrip("/")
        relative = relative.replace("/", os.sep)
        root = os.path.normpath(ROOT)
        full = os.path.normpath(os.path.join(root, relative))
        if os.path.commonpath([root, full]) != root or not os.path.isfile(full):
            self.send_json({"error": "Не найдено"}, 404)
            return
        mime = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if full.endswith(".svg"):
            mime = "image/svg+xml"
        with open(full, "rb") as handle:
            data = handle.read()
        self.send_response(200)
        self.send_header("Content-Type", mime if mime.startswith("image/") else f"{mime}; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://127.0.0.1:{PORT}/"
    print(f"Сайт открыт: {url}", flush=True)
    print("Чтобы остановить, закройте это окно или нажмите Ctrl+C", flush=True)
    if os.environ.get("NO_BROWSER") != "1":
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nСайт остановлен")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
