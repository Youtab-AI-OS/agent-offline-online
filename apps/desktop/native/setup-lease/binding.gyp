{
  "targets": [{
    "target_name": "setup_lease",
    "sources": ["setup_lease.cc"],
    "libraries": ["bcrypt.lib"],
    "conditions": [["OS!='win'", {"type": "none"}]]
  }]
}
