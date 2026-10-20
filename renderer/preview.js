// Browser demo only. The desktop app always uses the isolated preload bridge.
if (!window.todoAPI && /^https?:$/.test(window.location.protocol)) {
  let revision = "demo-0",
    pinned = false,
    sequence = 0;
  const today = TaskModel.localDate();
  const demo = `# TodoTree

## 目标
- [>] 让自己的小工具，被更多人用到
  - [>] 做一款愿意每天打开的桌面待办

## 待完成
- [!] 打磨 TodoTree 的第一印象 | ddl:${today}
  - [x] 保留喜欢的暗金色
  - [ ] 试试纸白和松绿主题
- [ ] 读完今天的论文，记下一个想法
- [ ] 傍晚出去走走，顺便买杯咖啡 | ddl:${today}

## 已完成
- [x] 把脑子里的计划，搬到桌面上
- [x] 给项目补上开源许可证

## 放弃
`;
  let content = demo;
  window.todoAPI = {
    isPreview: true,
    load: async () => ({
      success: true,
      content,
      revision,
      filePath: "演示任务.md",
      pinned,
    }),
    save: async (request) => {
      content = request.content;
      revision = "demo-" + ++sequence;
      return { success: true, revision };
    },
    saveCopy: async () => ({
      success: false,
      error: "演示页面不写入文件，请在桌面版中保存副本。",
    }),
    changeFile: async () => null,
    getZoneHeights: async () => ({}),
    saveZoneHeights: async () => {},
    getAutoStart: async () => false,
    toggleAutoStart: async () => false,
    togglePin: async () => (pinned = !pinned),
    onPinStateChanged: () => {},
    beginTransientEdit: async () => {},
    closeApp: async () => {},
    openBackups: async () => {},
  };
}
