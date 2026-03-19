-- 深大食堂菜品表：供方案推荐从数据库拉取真实菜品与热量
-- 在 Supabase Dashboard → SQL Editor 中执行此脚本

-- 表：食堂菜品
CREATE TABLE IF NOT EXISTS canteen_dishes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canteen_key TEXT NOT NULL DEFAULT 'szu_south',
  name TEXT NOT NULL,
  calories NUMERIC(8,2) NOT NULL DEFAULT 0,
  protein NUMERIC(6,2) NOT NULL DEFAULT 0,
  carbs NUMERIC(6,2) NOT NULL DEFAULT 0,
  fat NUMERIC(6,2) NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT 'lunch',
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE canteen_dishes IS '食堂菜品及营养信息，用于 AI 针对性推荐';
COMMENT ON COLUMN canteen_dishes.canteen_key IS '食堂标识，如 szu_south=深大南区';
COMMENT ON COLUMN canteen_dishes.category IS '餐段：breakfast=早餐, lunch=午餐, dinner=晚餐, snack=加餐';

-- 唯一约束：同一食堂下菜品名不重复，便于示例数据重复执行
CREATE UNIQUE INDEX IF NOT EXISTS idx_canteen_dishes_canteen_name
  ON canteen_dishes (canteen_key, name);

-- 索引：按食堂与餐段查询
CREATE INDEX IF NOT EXISTS idx_canteen_dishes_canteen_category
  ON canteen_dishes (canteen_key, category);

-- 启用 RLS（按需放宽策略）
ALTER TABLE canteen_dishes ENABLE ROW LEVEL SECURITY;

-- 允许匿名读取（后端用 anon key 拉取菜品）
CREATE POLICY "允许读取食堂菜品"
  ON canteen_dishes FOR SELECT
  USING (true);

-- 可选：仅允许通过 service_role 或认证用户写入（后续可加管理端）
-- CREATE POLICY "仅认证用户可写入"
--   ON canteen_dishes FOR ALL
--   USING (auth.role() = 'authenticated');

-- 示例数据：深大南区食堂（可按实际菜单增删改）
INSERT INTO canteen_dishes (canteen_key, name, calories, protein, carbs, fat, category, description) VALUES
  ('szu_south', '番茄炒蛋', 180, 10, 8, 12, 'lunch', '番茄、鸡蛋'),
  ('szu_south', '青椒肉丝', 220, 15, 6, 16, 'lunch', '青椒、猪里脊'),
  ('szu_south', '宫保鸡丁', 280, 18, 22, 14, 'lunch', '鸡丁、花生、干辣椒'),
  ('szu_south', '清蒸鲈鱼', 160, 22, 2, 8, 'lunch', '鲈鱼、姜葱'),
  ('szu_south', '蒜蓉西兰花', 55, 4, 8, 2, 'lunch', '西兰花、蒜'),
  ('szu_south', '米饭(两)', 230, 4, 50, 0.5, 'lunch', '白米饭'),
  ('szu_south', '皮蛋瘦肉粥', 120, 8, 18, 3, 'breakfast', '大米、皮蛋、瘦肉'),
  ('szu_south', '豆浆+油条', 320, 10, 38, 16, 'breakfast', '豆浆、油条'),
  ('szu_south', '鸡蛋饼', 200, 8, 22, 9, 'breakfast', '面粉、鸡蛋'),
  ('szu_south', '红烧肉', 450, 18, 12, 38, 'dinner', '五花肉、酱油'),
  ('szu_south', '酸辣土豆丝', 95, 2, 18, 3, 'dinner', '土豆、醋、辣椒'),
  ('szu_south', '紫菜蛋花汤', 45, 4, 3, 2, 'dinner', '紫菜、鸡蛋')
ON CONFLICT (canteen_key, name) DO NOTHING;
