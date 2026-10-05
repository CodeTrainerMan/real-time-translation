from PIL import Image
import os
import shutil

src = r'C:\Users\Administrator\WorkBuddy\2026-10-02-03-43-23\realtime-translation-icon\realtime-translation-icon-1024.png'
img = Image.open(src)
if img.mode != 'RGBA':
    img = img.convert('RGBA')

build_dir = r'E:\SY\project\Real-timeTranslation\build'
os.makedirs(build_dir, exist_ok=True)

sizes = [16, 24, 32, 48, 64, 128, 256]
frames = [img.resize((s, s), Image.LANCZOS) for s in sizes]

ico_path = os.path.join(build_dir, 'icon.ico')
frames[0].save(
    ico_path,
    format='ICO',
    sizes=[(f.width, f.height) for f in frames],
    append_images=frames[1:]
)
print('saved', ico_path, 'sizes', sizes)

icon_dir = r'C:\Users\Administrator\WorkBuddy\2026-10-02-03-43-23\realtime-translation-icon'
for name in [
    'realtime-translation-icon-512.png',
    'realtime-translation-icon-1024.png',
    'realtime-translation-icon-192.png',
]:
    shutil.copy2(os.path.join(icon_dir, name), build_dir)
    print('copied', name)
