import json, math

# 用法：
#   1) 下载国家测绘标准审图号地图的公开矢量化版本（DataV.GeoAtlas，含台湾省、港澳、南海诸岛）
#      curl -o china_full.json https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json
#   2) python3 tools/build_geo.py china_full.json js/data/geo.js
import sys
SRC = sys.argv[1] if len(sys.argv) > 1 else 'china_full.json'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'js/data/geo.js'

# 中国标准地图常用：Albers 等积割圆锥投影（中央经线105°E，双标准纬线25°N/47°N）
# 这里只做几何简化，投影在运行时 JS 中完成。

def rdp(pts, eps):
    """Douglas-Peucker 简化"""
    if len(pts) < 3:
        return pts
    # 迭代实现，避免递归过深
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        s, e = stack.pop()
        if e <= s + 1:
            continue
        ax, ay = pts[s][0], pts[s][1]
        bx, by = pts[e][0], pts[e][1]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        best, bi = -1.0, -1
        for i in range(s + 1, e):
            px, py = pts[i][0], pts[i][1]
            if norm == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                d = abs(dy * (px - ax) - dx * (py - ay)) / norm
            if d > best:
                best, bi = d, i
        if best > eps:
            keep[bi] = True
            stack.append((s, bi))
            stack.append((bi, e))
    return [p for p, k in zip(pts, keep) if k]


def ring_area(pts):
    a = 0.0
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        a += x1 * y2 - x2 * y1
    return abs(a) / 2


def simplify_ring(ring, eps):
    if len(ring) < 4:
        return None
    closed = ring[0] == ring[-1]
    pts = ring[:-1] if closed else ring[:]
    if len(pts) < 3:
        return None
    s = rdp(pts, eps)
    if len(s) < 3:
        return None
    return s


def process(coords, eps, min_area):
    """coords: MultiPolygon 坐标 → [[outer, hole...], ...]"""
    polys = []
    for poly in coords:
        rings = []
        for i, ring in enumerate(poly):
            e = eps if i == 0 else eps * 1.6
            s = simplify_ring(ring, e)
            if s is None:
                continue
            if i == 0 and ring_area(s) < min_area:
                continue
            rings.append([[round(x, 4), round(y, 4)] for x, y in s])
        if rings:
            polys.append(rings)
    return polys


data = json.load(open(SRC))
out = []
for f in data['features']:
    p = f['properties']
    code = str(p.get('adcode'))
    is_jd = code == '100000_JD'
    is_special = code in ('710000', '810000', '820000', '460000')
    tiny = code in ('810000', '820000')
    if is_jd:
        eps = 0.006
    elif tiny:
        eps = 0.0008          # 香港、澳门面积很小，必须保留细节
    elif is_special:
        eps = 0.005
    else:
        eps = 0.012
    min_area = 0.0 if (is_jd or is_special) else 0.02
    g = f['geometry']
    coords = g['coordinates']
    if g['type'] == 'Polygon':
        coords = [coords]
    polys = process(coords, eps, min_area)
    name = p.get('name') or '南海诸岛'
    if not polys:
        raise SystemExit('几何丢失：%s %s' % (code, name))
    out.append({'c': code, 'n': name, 'p': polys})

total = sum(len(r) for f in out for poly in f['p'] for r in poly)
print('features', len(out), 'rings', sum(len(f['p']) for f in out), 'pts', total)

js = ('// 中国省级行政区划边界数据（含台湾省、香港特别行政区、澳门特别行政区及南海诸岛界线）\n'
      '// 数据来源：国家测绘标准审图号地图的公开矢量化版本（DataV.GeoAtlas / 高德开放平台坐标系）\n'
      '// 坐标：[经度, 纬度]；已做几何抽稀，仅供教学可视化使用，不作为权属界线依据。\n'
      'export const CHINA_GEO = ' + json.dumps(out, ensure_ascii=False, separators=(',', ':')) + ';\n')

open(OUT, 'w').write(js)
print('wrote', OUT, len(js), 'bytes')
