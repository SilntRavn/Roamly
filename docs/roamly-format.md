# 漫迹行程文件 v1.0

扩展名 `.roamly`，内容编码 UTF-8，媒体类型 `application/json`。单文件包含必要的景点快照，可跨设备导入；地图、最新营业时间和 AI 调整仍需联网。

```json
{
  "format": "roamly.itinerary",
  "version": "1.0",
  "exportedAt": "2026-10-04T08:00:00.000Z",
  "itinerary": {
    "id": "uuid",
    "title": "杭州 · 1 日慢游",
    "city": "杭州",
    "summary": "沿西湖慢慢走，午间留出休息时间。",
    "preferences": {
      "pace": "relaxed",
      "interests": ["自然风景"],
      "travelers": 2,
      "budget": null,
      "transport": "walking"
    },
    "createdAt": "2026-10-04T08:00:00.000Z",
    "updatedAt": "2026-10-04T08:00:00.000Z",
    "days": [
      {
        "index": 1,
        "date": null,
        "title": "湖畔漫步",
        "items": [
          {
            "id": "item-uuid",
            "kind": "place",
            "placeId": "place-id",
            "title": "西湖",
            "arrival": "09:30",
            "durationMinutes": 120,
            "notes": "沿着湖边散步"
          }
        ]
      }
    ]
  },
  "places": [
    {
      "id": "place-id",
      "name": "西湖",
      "city": "杭州",
      "country": "中国",
      "address": "杭州西湖风景名胜区",
      "location": { "lng": 120.14, "lat": 30.25, "coordSystem": "GCJ-02" },
      "overview": "",
      "category": "风景名胜",
      "photo": "",
      "suggestedMinutes": 120,
      "openingHours": null,
      "price": null,
      "currency": "CNY",
      "source": {
        "provider": "高德 POI",
        "url": "",
        "updatedAt": "2026-10-04T08:00:00.000Z",
        "note": "示例字段，实际以接口返回为准"
      }
    }
  ]
}
```

- `arrival` 为目的地当地时间，24 小时 `HH:mm`；日期未确定时 `date=null`。`createdAt`/`updatedAt`/`exportedAt` 为 UTC ISO 时间戳。
- `kind=place` 必须引用 `places` 中的唯一 ID；休息 `kind=break`、`placeId=null`。
- 位置必须明确 `GCJ-02` 或 `WGS84`，不能混用。高德国内坐标为 GCJ-02。
- 地点可包含来源提供的 `province`（省）和 `district`（区县），与 `city`（所属城市）一起保留行政归属。例如临安景点的 `city=杭州市`、`district=临安区`；校验临安行程时仍限定在临安区。旧文件没有这两个字段也能读取，缺失时为空，不从景点名推测。
- 天数最多 14，每日最多 12 项、地点最多 100 个，文件最大 2 MB。
- `price=null` 表示未知；`price=0` 表示有来源支持的免费。预算为人均人民币，未知为 `null`。
- 不包含认证信息、账号 ID、评论、收藏状态、会话和已分享权限。
- 导入生成新的行程/项目/快照 ID；未知版本拒绝导入。图片目前只允许 HTTPS 地址和应用自带图片。
- 版本 1.0 不内嵌摄影二进制，也不保存实时交通；离线仍能读取文字与日程，图片、地图和路线核验需联网。

景点快照还支持以下可选字段（旧文件缺失时使用默认值）：`photos` 为最多三张图片地址，`photo` 仍表示卡片主图；`overviewSource` 为介绍来源 `{title,url,updatedAt}`，默认 `null`；`bookingChannels` 为预约渠道数组，默认空数组。每个渠道包含 `kind`（`website`、`miniprogram`、`official_account`）、`name`、`url`（公开 HTTPS 入口，缺失为 `null`）、`instructions` 和 `source`（同介绍来源结构）。不允许 JavaScript/微信私有 scheme 或未验证的 URL 格式。图片地址与来源链接随导出保留，但不内嵌图片或二维码。导入快照保留已保存的介绍和预约信息，不被后台搜索自动替换。

`itinerary.requirements` 为 v1.0 的可选字段，旧文件没有该字段也能读取。包含 `version:1`、目的城市、天数、出发日期、偏好、必去名称 `requiredPlaces`、必留快照 ID `requiredPlaceIds`、排除地点和 `fixedVisits`（地点 ID/名称、日序号、到达时间、停留时长），以及每日出发/结束时间、景点上限、交通步行/时长上限、休息时长、孩子年龄、长者与无障碍需求。没有明确数值要求的字段为 `null`。不包含原始对话或认证信息。

必留和固定地点的 ID 必须有快照；导入时随景点一起重映射。手工新增地点成为必留点；手工删除会解除相关约束，编辑已有点的日期、时间或停留会更新固定安排。连续 AI 修改保留约束，明确删除或重做才解除相应要求。`maxWalkingMeters` 表示景点间交通接驳步行目标，不能代替景区内步行统计。

`fixedVisits[].durationRule` 可选，默认 `exact` 表示指定的精确停留时长，`minimum` 表示至少停留指定分钟数。

`requirements.repeatPlaces` 默认为空数组，仅记录用户明确允许重复访问的地点名称。旧版或手工行程本来包含重复访问时保留该意图；AI 新增安排不能擅自把同一地点反复列在多天。

`requirements.nightTour` 可选，默认 `auto` 按目的地适配；`prefer` 表示希望夜游，`avoid` 表示不安排夜游。连续修改保留夜游意愿，用户明确更改时更新。`dailyStart`/`dailyEnd` 仍只记录用户的明确时间限制，不把产品默认作息写成硬限制。国内时间统一使用北京时间（`Asia/Shanghai`），包括新疆；白昼估算和地区建议不写成 POI 营业事实。
