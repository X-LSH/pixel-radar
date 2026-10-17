# data 分支

本分支由 `.github/workflows/collect.yml` 自动维护，**请勿手工提交**。

`snapshots/<ICAO>.json` 是各预设机场周边空域的最新 ADS-B 快照，
由 GitHub Actions 每 5 分钟重新采集一次覆盖更新。

前端通过 `raw.githubusercontent.com` 直读本分支：该域名带
`Access-Control-Allow-Origin: *`，且 CDN 缓存 5 分钟。

数据来源：adsb.lol（ODbL 许可）。仅供观察与学习，
不得用于飞行安全、导航或商业决策。
