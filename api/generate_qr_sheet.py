#!/usr/bin/env python3
import base64
import io
import json
import sys
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.lib.units import mm
from reportlab.pdfgen.canvas import Canvas


def draw_code(canvas, payload, action, instruction, x, y, width, height, accent):
    canvas.setFillColor(colors.HexColor("#F3F6F5"))
    canvas.roundRect(x, y, width, height, 5 * mm, fill=1, stroke=0)
    canvas.setFillColor(accent)
    canvas.roundRect(x + 8 * mm, y + height - 22 * mm, 34 * mm, 14 * mm, 3 * mm, fill=1, stroke=0)
    canvas.setFillColor(colors.white)
    canvas.setFont("Helvetica-Bold", 24)
    canvas.drawCentredString(x + 25 * mm, y + height - 17 * mm, action)
    image = ImageReader(io.BytesIO(base64.b64decode(payload)))
    qr_size = 74 * mm
    canvas.drawImage(image, x + (width - qr_size) / 2, y + 21 * mm, qr_size, qr_size, preserveAspectRatio=True, mask="auto")
    canvas.setFillColor(colors.HexColor("#172126"))
    canvas.setFont("Helvetica-Bold", 12)
    canvas.drawCentredString(x + width / 2, y + 12 * mm, instruction)


def make_pdf(data, output):
    labels = data["labels"]
    canvas = Canvas(output, pagesize=A4)
    page_width, page_height = A4
    canvas.setFillColor(colors.white)
    canvas.rect(0, 0, page_width, page_height, fill=1, stroke=0)
    green = colors.HexColor("#173F35")
    canvas.setFillColor(green)
    canvas.roundRect(15 * mm, page_height - 27 * mm, 14 * mm, 14 * mm, 3 * mm, fill=1, stroke=0)
    canvas.setFillColor(colors.white)
    canvas.setFont("Helvetica-Bold", 14)
    canvas.drawCentredString(22 * mm, page_height - 22 * mm, "O")
    canvas.setFillColor(colors.HexColor("#172126"))
    canvas.setFont("Helvetica-Bold", 19)
    canvas.drawString(34 * mm, page_height - 19 * mm, data["siteName"])
    canvas.setFont("Helvetica", 10)
    canvas.setFillColor(colors.HexColor("#64737B"))
    canvas.drawString(34 * mm, page_height - 25 * mm, f"{labels['entrance']}: {data['gateName']}")
    margin = 15 * mm
    gap = 7 * mm
    card_width = (page_width - 2 * margin - gap) / 2
    card_height = 122 * mm
    y = page_height - 158 * mm
    draw_code(canvas, data["inQrBase64"], "IN", labels["scanIn"], margin, y, card_width, card_height, colors.HexColor("#176B48"))
    draw_code(canvas, data["outQrBase64"], "OUT", labels["scanOut"], margin + card_width + gap, y, card_width, card_height, colors.HexColor("#A63D25"))
    canvas.setFillColor(colors.HexColor("#172126"))
    canvas.setFont("Helvetica-Bold", 13)
    canvas.drawCentredString(page_width / 2, y - 14 * mm, labels["instruction"])
    canvas.setFont("Helvetica", 9)
    canvas.setFillColor(colors.HexColor("#64737B"))
    canvas.drawCentredString(page_width / 2, y - 21 * mm, labels["locationNotice"])
    canvas.setStrokeColor(colors.HexColor("#D9E0E3"))
    canvas.line(margin, 18 * mm, page_width - margin, 18 * mm)
    canvas.setFont("Helvetica", 8)
    canvas.drawString(margin, 12 * mm, labels["footer"])
    canvas.drawRightString(page_width - margin, 12 * mm, data.get("generatedAt", ""))
    canvas.save()


if __name__ == "__main__":
    make_pdf(json.load(sys.stdin), sys.stdout.buffer)
