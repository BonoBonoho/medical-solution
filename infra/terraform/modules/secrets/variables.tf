variable "name" {
  type = string
}

variable "secret_names" {
  description = "시크릿 이름 → 설명. 값은 여기서 넣지 않는다"
  type        = map(string)
}

variable "tags" {
  type    = map(string)
  default = {}
}
