package com.ftpweb.client.model;

/**
 * 对应后端 get_dir 返回列表项（ftp 包 list 输出）。
 * 字段直接公开，由 Gson 反序列化；多余 JSON 字段（rights/owner/group 等）自动忽略。
 */
public class FtpItem {
    public String name;
    /** '-' = 文件, 'd' = 目录, 'l' = 链接 */
    public String type;
    public String size;
    public String date;
    /** 链接目标，可为空 */
    public String target;

    public FtpItem() {
    }

    public FtpItem(String name, String type, String size, String date, String target) {
        this.name = name;
        this.type = type;
        this.size = size;
        this.date = date;
        this.target = target;
    }

    public boolean isDirectory() {
        return "d".equals(type);
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getType() {
        return type;
    }

    public void setType(String type) {
        this.type = type;
    }

    public String getSize() {
        return size;
    }

    public void setSize(String size) {
        this.size = size;
    }

    public String getDate() {
        return date;
    }

    public void setDate(String date) {
        this.date = date;
    }

    public String getTarget() {
        return target;
    }

    public void setTarget(String target) {
        this.target = target;
    }
}
