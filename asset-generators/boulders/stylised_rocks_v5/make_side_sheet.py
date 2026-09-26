from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT.parent/'.deps'))
from PIL import Image,ImageDraw
from validate import load_font
out=Path(sys.argv[1]); paths=sorted((out/'renders').glob('*_depth.png'))
canvas=Image.new('RGB',(1740,1380),'#f0eee8'); draw=ImageDraw.Draw(canvas)
draw.text((30,22),'ROCK SIDES / BROADER CHUNKS',font=load_font(32,True),fill='#252928')
draw.text((32,68),'Steep side angle / larger natural masses and quieter colour variation',font=load_font(21),fill='#5a625f')
for i,path in enumerate(paths):
    x=(i%3)*580; y=120+(i//3)*630
    canvas.paste(Image.open(path).convert('RGB').resize((580,570),Image.Resampling.LANCZOS),(x,y))
    draw.text((x+22,y+585),path.stem[3:].replace('_depth','').replace('_',' ').upper(),font=load_font(24,True),fill='#252928')
canvas.save(out/'side_views.png')
