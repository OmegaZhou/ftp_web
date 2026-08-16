package com.ftpweb.client.ui;

import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;

import com.ftpweb.client.R;
import com.ftpweb.client.model.FtpItem;

import java.util.ArrayList;
import java.util.List;

/**
 * 目录/文件列表适配器。
 * 目录行显示「进入/删除/重命名」，文件行显示「下载/删除/重命名」。
 */
public class FileAdapter extends RecyclerView.Adapter<FileAdapter.ViewHolder> {

    public interface FileActionListener {
        void onEnterDir(FtpItem item);

        void onDownload(FtpItem item);

        void onDelete(FtpItem item);

        void onRename(FtpItem item);
    }

    private final List<FtpItem> items = new ArrayList<>();
    private final FileActionListener listener;

    public FileAdapter(FileActionListener listener) {
        this.listener = listener;
    }

    public void setItems(List<FtpItem> newItems) {
        items.clear();
        if (newItems != null) {
            items.addAll(newItems);
        }
        notifyDataSetChanged();
    }

    @NonNull
    @Override
    public ViewHolder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        View view = LayoutInflater.from(parent.getContext())
                .inflate(R.layout.item_file, parent, false);
        return new ViewHolder(view);
    }

    @Override
    public void onBindViewHolder(@NonNull ViewHolder holder, int position) {
        final FtpItem item = items.get(position);
        holder.tvName.setText(item.getName());
        boolean isDir = item.isDirectory();
        holder.ivIcon.setImageResource(isDir
                ? R.drawable.ic_folder
                : R.drawable.ic_file);

        holder.btnEnter.setVisibility(isDir ? View.VISIBLE : View.GONE);
        holder.btnDownload.setVisibility(isDir ? View.GONE : View.VISIBLE);

        if (isDir) {
            holder.btnEnter.setOnClickListener(v -> listener.onEnterDir(item));
        } else {
            holder.btnDownload.setOnClickListener(v -> listener.onDownload(item));
        }
        holder.btnDelete.setOnClickListener(v -> listener.onDelete(item));
        holder.btnRename.setOnClickListener(v -> listener.onRename(item));
    }

    @Override
    public int getItemCount() {
        return items.size();
    }

    static class ViewHolder extends RecyclerView.ViewHolder {
        final ImageView ivIcon;
        final TextView tvName;
        final Button btnEnter;
        final Button btnDownload;
        final Button btnDelete;
        final Button btnRename;

        ViewHolder(@NonNull View itemView) {
            super(itemView);
            ivIcon = itemView.findViewById(R.id.iv_icon);
            tvName = itemView.findViewById(R.id.tv_name);
            btnEnter = itemView.findViewById(R.id.btn_enter);
            btnDownload = itemView.findViewById(R.id.btn_download);
            btnDelete = itemView.findViewById(R.id.btn_delete);
            btnRename = itemView.findViewById(R.id.btn_rename);
        }
    }
}
