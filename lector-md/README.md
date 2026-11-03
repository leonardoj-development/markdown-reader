# Lector MD

Un lector de escritorio para tus carpetas Markdown en Windows. Elige una carpeta,
navega sus documentos desde el árbol lateral y lee sin distracciones.

## Lo que incluye

- Navegación recursiva: muestra las subcarpetas y sus archivos anidados, expandidos
  al abrir la carpeta o al recargarla.
- Renderizado de tablas, listas de tareas, citas, notas al pie, imágenes y bloques
  de código con resaltado de sintaxis.
- Índice lateral que sigue la lectura y permite saltar entre secciones.
- Búsqueda por nombre y búsqueda en el contenido de todos los documentos, sin
  distinguir mayúsculas ni tildes.
- Búsqueda dentro del documento con resaltado y navegación entre resultados.
- Temas claro, oscuro y del sistema; tamaño de letra ajustable.
- Historial de documentos, carpetas recientes y reapertura del último documento.
- Enlaces internos entre documentos y enlaces externos en el navegador.
- Imágenes locales, con vista ampliada al hacer clic.
- Ajustes persistentes y una carpeta de ejemplo incluida.
- Reconoce `.md`, `.markdown`, `.mdown`, `.mkd`, `.mdtext` y también `.md.txt`
  (extensión accidental frecuente).

La aplicación **solo lee** tus archivos: nunca modifica ni borra documentos.

## Abrir la aplicación

Desde la raíz del proyecto, haz doble clic en **`iniciar-lector.bat`**.

El lanzador:

1. Comprueba que exista el entorno `.venv` del proyecto.
2. La primera vez copia ese entorno a `%LOCALAPPDATA%\LectorMD-runtime`, para evitar
   problemas de .NET cuando el proyecto está dentro de Dropbox.
3. Abre la aplicación con `pythonw.exe`, sin ventana de consola.

Después de abrirla:

1. Pulsa **Abrir carpeta** y elige la carpeta con tus archivos Markdown.
2. Navega por el árbol del panel izquierdo; las subcarpetas aparecen expandidas.
3. Opcionalmente, prueba **Ver carpeta de ejemplo** en la pantalla de bienvenida.

Requisitos: Windows 10 u 11 con Microsoft Edge WebView2 Runtime. Windows 11 ya lo
incluye; en Windows 10 suele venir con Microsoft Edge.

## Atajos

| Acción | Atajo |
| --- | --- |
| Abrir carpeta | `Ctrl + O` |
| Mostrar u ocultar la barra lateral | `Ctrl + B` |
| Buscar en el documento | `Ctrl + F` |
| Siguiente / anterior resultado | `Enter` / `Mayús + Enter` |
| Ir atrás / adelante | `Alt + ←` / `Alt + →` |
| Recargar el documento | `F5` |
| Aumentar / reducir la letra | `Ctrl + +` / `Ctrl + −` |
| Filtrar documentos | `/` |
| Cerrar menús o búsqueda | `Esc` |

## Ejecutar desde el código

Requiere Python 3.12.

```powershell
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python app.py
```

Para abrir una carpeta concreta:

```powershell
.venv\Scripts\python app.py --folder "C:\Mis documentos\Notas"
```

## Estructura del proyecto

```text
app.py                  Punto de entrada y ventana de pywebview
lector_md/
  api.py                Puente entre la interfaz y Windows
  library.py            Escaneo recursivo, render Markdown y búsqueda
  settings.py           Preferencias y carpetas recientes
ui/                     Interfaz HTML, CSS y JavaScript
ejemplo/                Carpeta de demostración
assets/                 Icono de la aplicación
tests/                  Pruebas del backend
tools/make_assets.py    Regenera el icono y la portada de ejemplo
```

El lanzador `iniciar-lector.bat` está en la carpeta superior del proyecto.

Los ajustes se guardan en `%APPDATA%\LectorMD\settings.json` y el registro de la
aplicación en `%APPDATA%\LectorMD\lector-md.log`.

## Seguridad

- El contenido Markdown se renderiza con HTML sin procesar: el HTML crudo se
  escapa, no se ejecuta.
- Todas las rutas se resuelven dentro de la carpeta abierta; los enlaces no pueden
  salir de ella sin pasar por la validación correspondiente.
- Las imágenes locales se incrustan como datos y no se carga código desde la red.
- Los enlaces externos se abren en el navegador predeterminado.

## Pruebas

```powershell
.venv\Scripts\python -m unittest discover -s tests -v
```
