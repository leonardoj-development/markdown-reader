"""Genera el icono de la aplicación y la portada de la carpeta de ejemplo."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
EJEMPLO = ROOT / "ejemplo" / "imagenes"
ASSETS.mkdir(parents=True, exist_ok=True)
EJEMPLO.mkdir(parents=True, exist_ok=True)


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "C:/Windows/Fonts/seguisb.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
    ]
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


def vertical_gradient(size: tuple[int, int], top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    image = Image.new("RGB", size, top)
    draw = ImageDraw.Draw(image)
    width, height = size
    for y in range(height):
        t = y / max(1, height - 1)
        color = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        draw.line((0, y, width, y), fill=color)
    return image


def make_icon() -> None:
    size = 1024
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle((64, 80, 960, 976), radius=210, fill=(9, 28, 22, 90))
    shadow = shadow.filter(__import__("PIL.ImageFilter", fromlist=["GaussianBlur"]).GaussianBlur(38))
    image.alpha_composite(shadow)

    mark = vertical_gradient((size, size), (38, 108, 88), (19, 65, 52)).convert("RGBA")
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((52, 52, 972, 972), radius=205, fill=255)
    image.paste(mark, (0, 0), mask)

    draw = ImageDraw.Draw(image)
    # Página de papel
    page = (300, 218, 724, 806)
    draw.rounded_rectangle(page, radius=38, fill=(250, 247, 238, 255))
    # Esquina doblada
    draw.polygon([(626, 218), (724, 316), (626, 316)], fill=(230, 224, 208, 255))
    draw.line([(626, 218), (626, 316), (724, 316)], fill=(208, 201, 184, 255), width=5)
    # Lomo y detalle
    draw.rounded_rectangle((330, 260, 354, 762), radius=12, fill=(224, 160, 82, 255))
    # Líneas de texto
    for y, width in ((392, 250), (458, 292), (524, 210), (590, 260)):
        draw.rounded_rectangle((396, y, 396 + width, y + 22), radius=11, fill=(48, 112, 92, 210))
    # Marca #
    hash_font = font(160, bold=True)
    draw.text((430, 626), "#", font=hash_font, fill=(31, 94, 77, 255))
    # Marcador
    draw.rounded_rectangle((646, 170, 688, 292), radius=8, fill=(208, 143, 70, 255))
    draw.polygon([(646, 292), (667, 264), (688, 292)], fill=(208, 143, 70, 255))

    icon = image.resize((512, 512), Image.LANCZOS)
    icon.save(ASSETS / "icon.png")
    icon.save(ASSETS / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("Icono:", ASSETS / "icon.ico")


def make_banner() -> None:
    width, height = 1400, 520
    image = vertical_gradient((width, height), (26, 76, 62), (14, 41, 33)).convert("RGBA")
    draw = ImageDraw.Draw(image)

    # Patrón de puntos sutil
    for x in range(0, width, 34):
        for y in range(0, height, 34):
            alpha = 18 if (x // 34 + y // 34) % 3 else 28
            draw.ellipse((x, y, x + 2, y + 2), fill=(227, 238, 231, alpha))

    # Formas decorativas
    draw.ellipse((930, -210, 1510, 370), fill=(44, 115, 94, 120))
    draw.ellipse((1110, 260, 1400, 550), fill=(191, 133, 68, 60))
    draw.rounded_rectangle((1050, 95, 1320, 430), radius=22, fill=(31, 74, 61, 110), outline=(90, 157, 132, 80), width=2)

    # Tarjeta de documento
    card_left, card_top = 812, 88
    draw.rounded_rectangle((card_left + 12, card_top + 16, card_left + 328, card_top + 380), radius=18, fill=(4, 15, 11, 110))
    draw.rounded_rectangle((card_left, card_top, card_left + 316, card_top + 364), radius=18, fill=(250, 247, 238, 255))
    draw.rounded_rectangle((card_left + 26, card_top + 28, card_left + 44, card_top + 332), radius=7, fill=(211, 152, 76, 255))
    hash_font = font(86, bold=True)
    draw.text((card_left + 76, card_top + 58), "#", font=hash_font, fill=(33, 102, 84, 255))
    for index, line_width in enumerate((172, 208, 148, 190)):
        y = card_top + 178 + index * 38
        draw.rounded_rectangle((card_left + 76, y, card_left + 76 + line_width, y + 13), radius=6, fill=(201, 218, 209, 255))
    draw.rounded_rectangle((card_left + 76, card_top + 322, card_left + 206, card_top + 338), radius=8, fill=(220, 168, 98, 255))

    # Texto
    draw.text((88, 128), "LECTOR MD", font=font(25, bold=True), fill=(155, 206, 183, 255))
    title_font = font(74, bold=True)
    draw.text((84, 180), "Leer sin ruido.", font=title_font, fill=(250, 247, 238, 255))
    serif = "C:/Windows/Fonts/georgiai.ttf"
    try:
        accent_font = ImageFont.truetype(serif, 68)
    except OSError:
        accent_font = font(66)
    draw.text((84, 266), "Navegar sin perderte.", font=accent_font, fill=(146, 207, 181, 255))
    draw.text((88, 387), "Una biblioteca tranquila para tus documentos Markdown.", font=font(23), fill=(190, 208, 196, 255))

    image.convert("RGB").save(EJEMPLO / "portada.png", quality=92)
    print("Portada:", EJEMPLO / "portada.png")


if __name__ == "__main__":
    make_icon()
    make_banner()
